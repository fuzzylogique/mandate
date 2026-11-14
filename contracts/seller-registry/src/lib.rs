//! Seller registry: which Stellar accounts belong to which verified domain.
//!
//! An attester (the admin) records an address and nonempty metadata here.
//! Off-chain checks are the attester's responsibility; this contract does not
//! validate SEP-1, domain ownership or legal identity. The workspace prototype
//! automatically records workspace metadata for deployed Smart Accounts.
//! Payment policies read this registry before authorizing a recipient.
#![no_std]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, Address,
    Env, String,
};

const DAY_IN_LEDGERS: u32 = 17_280;
const TTL_EXTEND_TO: u32 = 30 * DAY_IN_LEDGERS;
const TTL_THRESHOLD: u32 = TTL_EXTEND_TO - DAY_IN_LEDGERS;

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Seller(Address),
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct SellerInfo {
    /// Domain whose stellar.toml lists this account, e.g. "weather.example".
    pub domain: String,
    /// Ledger at which the attester recorded the check.
    pub verified_at_ledger: u32,
}

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq)]
#[repr(u32)]
pub enum RegistryError {
    AdminNotSet = 1,
    EmptyDomain = 2,
}

#[contractevent]
#[derive(Clone, Debug)]
pub struct SellerRegistered {
    #[topic]
    pub seller: Address,
    pub domain: String,
}

#[contractevent]
#[derive(Clone, Debug)]
pub struct SellerRevoked {
    #[topic]
    pub seller: Address,
}

#[contract]
pub struct SellerRegistry;

#[contractimpl]
impl SellerRegistry {
    pub fn __constructor(e: &Env, admin: Address) {
        e.storage().instance().set(&DataKey::Admin, &admin);
    }

    /// Record that `seller` is the payment account of `domain`. Admin only.
    pub fn register(e: &Env, seller: Address, domain: String) {
        Self::admin(e).require_auth();
        if domain.is_empty() {
            panic_with_error!(e, RegistryError::EmptyDomain)
        }
        let key = DataKey::Seller(seller.clone());
        let info =
            SellerInfo { domain: domain.clone(), verified_at_ledger: e.ledger().sequence() };
        e.storage().persistent().set(&key, &info);
        e.storage().persistent().extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);
        SellerRegistered { seller, domain }.publish(e);
    }

    /// Remove a seller, e.g. after a domain changes hands. Admin only.
    pub fn revoke(e: &Env, seller: Address) {
        Self::admin(e).require_auth();
        e.storage().persistent().remove(&DataKey::Seller(seller.clone()));
        SellerRevoked { seller }.publish(e);
    }

    pub fn is_verified(e: &Env, seller: Address) -> bool {
        Self::get(e, seller).is_some()
    }

    pub fn get(e: &Env, seller: Address) -> Option<SellerInfo> {
        let key = DataKey::Seller(seller);
        let info: Option<SellerInfo> = e.storage().persistent().get(&key);
        if info.is_some() {
            e.storage().persistent().extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);
        }
        info
    }

    pub fn admin(e: &Env) -> Address {
        match e.storage().instance().get(&DataKey::Admin) {
            Some(admin) => admin,
            None => panic_with_error!(e, RegistryError::AdminNotSet),
        }
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::Address as _;

    #[test]
    fn register_then_revoke() {
        let e = Env::default();
        e.mock_all_auths();
        let admin = Address::generate(&e);
        let seller = Address::generate(&e);
        let id = e.register(SellerRegistry, (admin.clone(),));
        let client = SellerRegistryClient::new(&e, &id);

        assert!(!client.is_verified(&seller));
        client.register(&seller, &String::from_str(&e, "weather.example"));
        assert!(client.is_verified(&seller));
        assert_eq!(client.get(&seller).unwrap().domain, String::from_str(&e, "weather.example"));

        client.revoke(&seller);
        assert!(!client.is_verified(&seller));
    }
}
