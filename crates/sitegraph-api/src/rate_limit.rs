//! Minimal in-memory rate limiter (WP1.6 / Whitepaper §19).
//!
//! Fixed-window counter keyed by an arbitrary string (token hash, client IP).
//! Single-instance only — a multi-node deployment needs a shared store (Redis);
//! that's a Phase 2 concern (WP2.2). Kept dependency-free on purpose.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub struct RateLimiter {
    window: Duration,
    max: u32,
    state: Mutex<HashMap<String, (Instant, u32)>>,
}

impl RateLimiter {
    /// Allow at most `max` requests per `window_secs` per key.
    pub fn new(max: u32, window_secs: u64) -> Self {
        Self {
            window: Duration::from_secs(window_secs),
            max,
            state: Mutex::new(HashMap::new()),
        }
    }

    /// Record a hit; returns `true` if it is within the limit.
    pub fn check(&self, key: &str) -> bool {
        let now = Instant::now();
        let mut map = self.state.lock().expect("rate limiter poisoned");

        // Opportunistic cleanup so the map can't grow without bound.
        if map.len() > 10_000 {
            map.retain(|_, (start, _)| now.duration_since(*start) < self.window);
        }

        match map.get_mut(key) {
            Some(entry) if now.duration_since(entry.0) < self.window => {
                if entry.1 >= self.max {
                    return false;
                }
                entry.1 += 1;
                true
            }
            _ => {
                map.insert(key.to_string(), (now, 1));
                true
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_up_to_max_then_blocks() {
        let rl = RateLimiter::new(3, 60);
        assert!(rl.check("k"));
        assert!(rl.check("k"));
        assert!(rl.check("k"));
        assert!(!rl.check("k"), "4th request in window must be blocked");
        // A different key is independent.
        assert!(rl.check("other"));
    }
}
