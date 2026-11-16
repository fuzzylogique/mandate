//! A mandate signer must identify an agent registered to its source account.
//! The mandate signature binds the identity to the account/rule/payment digest.
#![no_std]
use soroban_sdk::{
    contract, contractclient, contractevent, contractimpl, contracttype,
    xdr::{FromXdr, ToXdr},
    Address, Bytes, BytesN, Env, String, Vec,
};
use stellar_accounts::verifiers::{ed25519, Verifier};
#[contractclient(name = "RegistryClient")]
pub trait Registry {
    fn is_verified(e: Env, account: Address, agent_id: String) -> bool;
}
#[contracttype]
#[derive(Clone)]
pub struct AgentKey {
    pub account: Address,
    pub public_key: BytesN<32>,
}
#[contracttype]
#[derive(Clone)]
pub struct AgentSignature {
    pub agent_id: String,
    pub signature: BytesN<64>,
}
#[contracttype]
#[derive(Clone)]
pub struct AgentDigest {
    pub agent_id: String,
    pub payload: Bytes,
}
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Registry,
}
#[contractevent]
#[derive(Clone, Debug)]
pub struct AgentAuthorized {
    #[topic]
    pub account: Address,
    pub agent_id: String,
}
#[contract]
pub struct AgentVerifier;
#[contractimpl]
impl AgentVerifier {
    pub fn __constructor(e: &Env, registry: Address) {
        e.storage().instance().set(&DataKey::Registry, &registry);
    }
    pub fn registry(e: &Env) -> Address {
        e.storage().instance().get(&DataKey::Registry).unwrap()
    }
}
#[contractimpl]
impl Verifier for AgentVerifier {
    type KeyData = Bytes;
    type SigData = Bytes;
    fn verify(e: &Env, payload: Bytes, key_data: Bytes, sig_data: Bytes) -> bool {
        let key = AgentKey::from_xdr(e, &key_data).unwrap();
        let sig = AgentSignature::from_xdr(e, &sig_data).unwrap();
        if !RegistryClient::new(e, &Self::registry(e)).is_verified(&key.account, &sig.agent_id) {
            return false;
        }
        let digest = e
            .crypto()
            .sha256(
                &AgentDigest {
                    agent_id: sig.agent_id.clone(),
                    payload,
                }
                .to_xdr(e),
            )
            .to_bytes();
        ed25519::verify(e, &digest.into(), &key.public_key, &sig.signature);
        AgentAuthorized {
            account: key.account,
            agent_id: sig.agent_id,
        }
        .publish(e);
        true
    }
    fn canonicalize_key(e: &Env, key_data: Bytes) -> Bytes {
        AgentKey::from_xdr(e, &key_data).unwrap().public_key.into()
    }
    fn batch_canonicalize_key(e: &Env, keys_data: Vec<Bytes>) -> Vec<Bytes> {
        Vec::from_iter(
            e,
            keys_data.iter().map(|key| Self::canonicalize_key(e, key)),
        )
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use soroban_sdk::testutils::Address as _;
    #[contract]
    struct TestRegistry;
    #[contractimpl]
    impl TestRegistry {
        pub fn allow(e: Env, account: Address, agent_id: String) {
            e.storage().persistent().set(&(account, agent_id), &true);
        }
        pub fn revoke(e: Env, account: Address, agent_id: String) {
            e.storage().persistent().remove(&(account, agent_id));
        }
        pub fn is_verified(e: Env, account: Address, agent_id: String) -> bool {
            e.storage().persistent().has(&(account, agent_id))
        }
    }
    #[test]
    fn verifies_any_registered_agent_but_rejects_foreign_revoked_and_tampered_identities() {
        let e = Env::default();
        e.mock_all_auths();
        let registry = e.register(TestRegistry, ());
        let verifier = e.register(AgentVerifier, (registry.clone(),));
        let account = Address::generate(&e);
        let other = Address::generate(&e);
        let signing = SigningKey::from_bytes(&[7; 32]);
        let key = AgentKey {
            account: account.clone(),
            public_key: BytesN::from_array(&e, &signing.verifying_key().to_bytes()),
        }
        .to_xdr(&e);
        let payload = Bytes::from_array(&e, &[9; 32]);
        let buyer = String::from_str(&e, "buyer");
        let assistant = String::from_str(&e, "assistant");
        let registry_client = TestRegistryClient::new(&e, &registry);
        let client = AgentVerifierClient::new(&e, &verifier);
        let sign = |agent_id: String| {
            let digest = e
                .crypto()
                .sha256(
                    &AgentDigest {
                        agent_id: agent_id.clone(),
                        payload: payload.clone(),
                    }
                    .to_xdr(&e),
                )
                .to_array();
            AgentSignature {
                agent_id,
                signature: BytesN::from_array(&e, &signing.sign(&digest).to_bytes()),
            }
        };
        let signed = sign(buyer.clone());
        assert!(!client.verify(&payload, &key, &signed.clone().to_xdr(&e)));
        registry_client.allow(&other, &buyer);
        assert!(!client.verify(&payload, &key, &signed.clone().to_xdr(&e)));
        registry_client.allow(&account, &buyer);
        registry_client.allow(&account, &assistant);
        assert!(client.verify(&payload, &key, &signed.clone().to_xdr(&e)));
        assert!(client.verify(&payload, &key, &sign(assistant.clone()).to_xdr(&e)));
        let tampered = AgentSignature {
            agent_id: assistant,
            ..signed.clone()
        };
        assert!(client
            .try_verify(&payload, &key, &tampered.to_xdr(&e))
            .is_err());
        registry_client.revoke(&account, &buyer);
        assert!(!client.verify(&payload, &key, &signed.to_xdr(&e)));
    }
}
