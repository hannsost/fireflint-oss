use kube::CustomResourceExt;
use sitegraph_operator_api::{
    SiteGraphDataStore, SiteGraphStorageBinding, SiteGraphStorageProfile,
};

fn main() -> Result<(), serde_yaml::Error> {
    let crds = [
        serde_yaml::to_string(&SiteGraphStorageProfile::crd())?,
        serde_yaml::to_string(&SiteGraphDataStore::crd())?,
        serde_yaml::to_string(&SiteGraphStorageBinding::crd())?,
    ];
    println!("{}", crds.join("---\n"));
    Ok(())
}
