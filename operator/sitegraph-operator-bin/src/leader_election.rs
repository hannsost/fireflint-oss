use k8s_openapi::{
    api::coordination::v1::{Lease, LeaseSpec},
    apimachinery::pkg::apis::meta::v1::{MicroTime, ObjectMeta},
    jiff::Timestamp,
};
use kube::{
    api::{PostParams, ResourceExt},
    Api, Client,
};
use std::time::Duration;
use tokio::time::sleep;
use tracing::{debug, info, warn};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LeaderElectionConfig {
    pub namespace: String,
    pub lease_name: String,
    pub identity: String,
    pub lease_duration: Duration,
    pub retry_period: Duration,
}

impl LeaderElectionConfig {
    pub fn validate(&self) -> Result<(), LeaderElectionError> {
        for (field, value) in [
            ("namespace", self.namespace.as_str()),
            ("lease_name", self.lease_name.as_str()),
            ("identity", self.identity.as_str()),
        ] {
            if value.trim().is_empty() {
                return Err(LeaderElectionError::InvalidConfig(format!(
                    "{field} must not be empty"
                )));
            }
        }
        if self.lease_duration.as_secs() < 2 {
            return Err(LeaderElectionError::InvalidConfig(
                "lease_duration must be at least two seconds".into(),
            ));
        }
        if self.retry_period.is_zero() || self.retry_period >= self.lease_duration {
            return Err(LeaderElectionError::InvalidConfig(
                "retry_period must be positive and shorter than lease_duration".into(),
            ));
        }
        if self.lease_duration.as_secs() > i32::MAX as u64 {
            return Err(LeaderElectionError::InvalidConfig(
                "lease_duration exceeds Kubernetes Lease limits".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, thiserror::Error)]
pub enum LeaderElectionError {
    #[error("invalid leader-election configuration: {0}")]
    InvalidConfig(String),
    #[error("Kubernetes Lease operation failed")]
    Kubernetes(#[from] kube::Error),
    #[error("leadership was lost")]
    LostLeadership,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LeaseSnapshot {
    pub holder_identity: Option<String>,
    pub renew_time_seconds: Option<i64>,
    pub lease_duration_seconds: Option<i32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LeaseDecision {
    Acquire,
    Renew,
    Wait,
}

pub fn decide_lease(
    lease: Option<&LeaseSnapshot>,
    identity: &str,
    now_seconds: i64,
) -> LeaseDecision {
    let Some(lease) = lease else {
        return LeaseDecision::Acquire;
    };
    if lease.holder_identity.as_deref() == Some(identity) {
        return LeaseDecision::Renew;
    }
    if lease.holder_identity.is_none() {
        return LeaseDecision::Acquire;
    }
    let expires_at = lease
        .renew_time_seconds
        .zip(lease.lease_duration_seconds)
        .map(|(renewed, duration)| renewed.saturating_add(i64::from(duration)));
    match expires_at {
        Some(expires_at) if now_seconds >= expires_at => LeaseDecision::Acquire,
        Some(_) | None => LeaseDecision::Wait,
    }
}

#[derive(Clone)]
pub struct LeaseElector {
    api: Api<Lease>,
    config: LeaderElectionConfig,
}

impl LeaseElector {
    pub fn new(client: Client, config: LeaderElectionConfig) -> Result<Self, LeaderElectionError> {
        config.validate()?;
        Ok(Self {
            api: Api::namespaced(client, &config.namespace),
            config,
        })
    }

    pub async fn acquire(&self) -> Result<(), LeaderElectionError> {
        loop {
            if self.acquire_or_renew().await? {
                info!(
                    lease = %self.config.lease_name,
                    identity = %self.config.identity,
                    "leadership acquired"
                );
                return Ok(());
            }
            debug!(
                lease = %self.config.lease_name,
                "leadership held by another operator"
            );
            sleep(self.config.retry_period).await;
        }
    }

    pub async fn renew_until_lost(&self) -> Result<(), LeaderElectionError> {
        loop {
            sleep(self.config.retry_period).await;
            match self.acquire_or_renew().await {
                Ok(true) => {}
                Ok(false) => return Err(LeaderElectionError::LostLeadership),
                Err(error) => {
                    warn!(error = %error, "leader lease renewal failed");
                    sleep(self.config.retry_period).await;
                    if !self.acquire_or_renew().await? {
                        return Err(LeaderElectionError::LostLeadership);
                    }
                }
            }
        }
    }

    async fn acquire_or_renew(&self) -> Result<bool, LeaderElectionError> {
        let now = Timestamp::now();
        let current = self.api.get_opt(&self.config.lease_name).await?;
        let snapshot = current.as_ref().map(lease_snapshot);
        let decision = decide_lease(snapshot.as_ref(), &self.config.identity, now.as_second());

        match (current, decision) {
            (_, LeaseDecision::Wait) => Ok(false),
            (None, LeaseDecision::Acquire) => self.create_lease(now).await,
            (Some(lease), LeaseDecision::Acquire) => self.replace_lease(lease, now, true).await,
            (Some(lease), LeaseDecision::Renew) => self.replace_lease(lease, now, false).await,
            (None, LeaseDecision::Renew) => Ok(false),
        }
    }

    async fn create_lease(&self, now: Timestamp) -> Result<bool, LeaderElectionError> {
        let lease = Lease {
            metadata: ObjectMeta {
                name: Some(self.config.lease_name.clone()),
                namespace: Some(self.config.namespace.clone()),
                ..ObjectMeta::default()
            },
            spec: Some(LeaseSpec {
                acquire_time: Some(MicroTime(now)),
                holder_identity: Some(self.config.identity.clone()),
                lease_duration_seconds: Some(self.config.lease_duration.as_secs() as i32),
                lease_transitions: Some(0),
                renew_time: Some(MicroTime(now)),
                ..LeaseSpec::default()
            }),
        };
        match self.api.create(&PostParams::default(), &lease).await {
            Ok(_) => Ok(true),
            Err(kube::Error::Api(response)) if response.code == 409 => Ok(false),
            Err(error) => Err(error.into()),
        }
    }

    async fn replace_lease(
        &self,
        mut lease: Lease,
        now: Timestamp,
        transition: bool,
    ) -> Result<bool, LeaderElectionError> {
        let previous = lease.spec.take().unwrap_or_default();
        lease.spec = Some(LeaseSpec {
            acquire_time: if transition {
                Some(MicroTime(now))
            } else {
                previous.acquire_time
            },
            holder_identity: Some(self.config.identity.clone()),
            lease_duration_seconds: Some(self.config.lease_duration.as_secs() as i32),
            lease_transitions: Some(if transition {
                previous.lease_transitions.unwrap_or_default() + 1
            } else {
                previous.lease_transitions.unwrap_or_default()
            }),
            renew_time: Some(MicroTime(now)),
            ..LeaseSpec::default()
        });
        let name = lease.name_any();
        match self
            .api
            .replace(&name, &PostParams::default(), &lease)
            .await
        {
            Ok(_) => Ok(true),
            Err(kube::Error::Api(response)) if response.code == 409 => Ok(false),
            Err(error) => Err(error.into()),
        }
    }
}

fn lease_snapshot(lease: &Lease) -> LeaseSnapshot {
    let spec = lease.spec.as_ref();
    LeaseSnapshot {
        holder_identity: spec.and_then(|spec| spec.holder_identity.clone()),
        renew_time_seconds: spec
            .and_then(|spec| spec.renew_time.as_ref())
            .map(|time| time.0.as_second()),
        lease_duration_seconds: spec.and_then(|spec| spec.lease_duration_seconds),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(holder: &str, renewed: i64, duration: i32) -> LeaseSnapshot {
        LeaseSnapshot {
            holder_identity: Some(holder.into()),
            renew_time_seconds: Some(renewed),
            lease_duration_seconds: Some(duration),
        }
    }

    #[test]
    fn absent_lease_can_be_acquired() {
        assert_eq!(decide_lease(None, "pod-a", 100), LeaseDecision::Acquire);
    }

    #[test]
    fn current_holder_renews_before_expiry() {
        assert_eq!(
            decide_lease(Some(&snapshot("pod-a", 100, 15)), "pod-a", 101),
            LeaseDecision::Renew
        );
    }

    #[test]
    fn another_holder_is_respected_before_expiry() {
        assert_eq!(
            decide_lease(Some(&snapshot("pod-a", 100, 15)), "pod-b", 114),
            LeaseDecision::Wait
        );
    }

    #[test]
    fn expired_lease_can_be_acquired() {
        assert_eq!(
            decide_lease(Some(&snapshot("pod-a", 100, 15)), "pod-b", 115),
            LeaseDecision::Acquire
        );
    }

    #[test]
    fn incomplete_foreign_lease_fails_closed() {
        let incomplete = LeaseSnapshot {
            holder_identity: Some("stale".into()),
            renew_time_seconds: None,
            lease_duration_seconds: None,
        };
        assert_eq!(
            decide_lease(Some(&incomplete), "pod-b", 100),
            LeaseDecision::Wait
        );
    }

    #[test]
    fn invalid_timing_is_rejected() {
        let config = LeaderElectionConfig {
            namespace: "sitegraph-system".into(),
            lease_name: "sitegraph-operator".into(),
            identity: "pod-a".into(),
            lease_duration: Duration::from_secs(10),
            retry_period: Duration::from_secs(10),
        };
        assert!(config.validate().is_err());
    }
}
