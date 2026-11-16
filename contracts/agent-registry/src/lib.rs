//! Account-scoped agent identification, attested by the registry administrator.
#![no_std]
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, Address,
    Env, String,
};

const TTL: u32 = 30 * 17_280;
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Agent(Address, String),
}
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct AgentInfo {
    pub name: String,
    pub verified_at_ledger: u32,
}
#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq)]
#[repr(u32)]
pub enum RegistryError {
    InvalidIdentity = 1,
}
#[contractevent]
#[derive(Clone, Debug)]
pub struct AgentRegistered {
    #[topic]
    pub account: Address,
    pub agent_id: String,
}
#[contractevent]
#[derive(Clone, Debug)]
pub struct AgentRevoked {
    #[topic]
    pub account: Address,
    pub agent_id: String,
}
#[contract]
pub struct AgentRegistry;
#[contractimpl]
impl AgentRegistry {
    pub fn __constructor(e: &Env, admin: Address) {
        e.storage().instance().set(&DataKey::Admin, &admin);
    }
    pub fn admin(e: &Env) -> Address {
        e.storage().instance().get(&DataKey::Admin).unwrap()
    }
    pub fn register(e: &Env, account: Address, agent_id: String, name: String) {
        Self::admin(e).require_auth();
        if account.to_string().to_bytes().get(0) != Some(b'C')
            || agent_id.is_empty()
            || agent_id.len() > 128
            || name.is_empty()
            || name.len() > 480
        {
            panic_with_error!(e, RegistryError::InvalidIdentity)
        }
        let key = DataKey::Agent(account.clone(), agent_id.clone());
        e.storage().persistent().set(
            &key,
            &AgentInfo {
                name,
                verified_at_ledger: e.ledger().sequence(),
            },
        );
        e.storage().persistent().extend_ttl(&key, TTL - 17_280, TTL);
        AgentRegistered { account, agent_id }.publish(e);
    }
    pub fn revoke(e: &Env, account: Address, agent_id: String) {
        Self::admin(e).require_auth();
        e.storage()
            .persistent()
            .remove(&DataKey::Agent(account.clone(), agent_id.clone()));
        AgentRevoked { account, agent_id }.publish(e);
    }
    pub fn is_verified(e: &Env, account: Address, agent_id: String) -> bool {
        Self::get(e, account, agent_id).is_some()
    }
    pub fn get(e: &Env, account: Address, agent_id: String) -> Option<AgentInfo> {
        let key = DataKey::Agent(account, agent_id);
        let result = e.storage().persistent().get(&key);
        if result.is_some() {
            e.storage().persistent().extend_ttl(&key, TTL - 17_280, TTL);
        }
        result
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::Address as _;
    #[test]
    fn registration_is_account_scoped_and_revocable() {
        let e = Env::default();
        e.mock_all_auths();
        let admin = Address::generate(&e);
        let account = Address::generate(&e);
        let other = Address::generate(&e);
        let id = e.register(AgentRegistry, (admin,));
        let client = AgentRegistryClient::new(&e, &id);
        let agent = String::from_str(&e, "agt_buyer");
        client.register(&account, &agent, &String::from_str(&e, "Buyer"));
        assert!(client.is_verified(&account, &agent));
        assert!(!client.is_verified(&other, &agent));
        client.revoke(&account, &agent);
        assert!(!client.is_verified(&account, &agent));
    }
    #[test]
    fn registration_requires_admin_authorization() {
        let e = Env::default();
        let id = e.register(AgentRegistry, (Address::generate(&e),));
        assert!(AgentRegistryClient::new(&e, &id)
            .try_register(
                &Address::generate(&e),
                &String::from_str(&e, "agt_buyer"),
                &String::from_str(&e, "Buyer")
            )
            .is_err());
    }
}
