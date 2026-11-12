//! Verified-seller policy: an agent may only pay accounts listed in the
//! seller registry.
//!
//! Attach it to an agent's context rule next to the spending limit policy.
//! All policies on a rule must pass, so a payment goes through only if the
//! recipient is verified AND the amount fits the limit.
//!
//! On success it emits `PaymentAuthorized`, the on-chain anchor that the
//! receipt service turns into a receipt.
#![no_std]

use soroban_sdk::{
    auth::{Context, ContractContext},
    contract, contractclient, contracterror, contractevent, contractimpl, contracttype,
    panic_with_error, symbol_short, Address, Env, TryFromVal, Vec,
};
use stellar_accounts::{
    policies::Policy,
    smart_account::{ContextRule, ContextRuleType, Signer},
};

const DAY_IN_LEDGERS: u32 = 17_280;
const TTL_EXTEND_TO: u32 = 30 * DAY_IN_LEDGERS;
const TTL_THRESHOLD: u32 = TTL_EXTEND_TO - DAY_IN_LEDGERS;

/// The one registry function this policy needs.
#[contractclient(name = "SellerRegistryClient")]
pub trait SellerRegistryInterface {
    fn is_verified(e: Env, seller: Address) -> bool;
}

/// Install parameters, chosen per mandate.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct VerifiedSellerParams {
    pub registry: Address,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// (smart account, context rule id) -> registry address
    Registry(Address, u32),
}

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq)]
#[repr(u32)]
pub enum VerifiedSellerError {
    /// Policy is not installed for this account and rule.
    NotInstalled = 1,
    /// Policy is already installed for this account and rule.
    AlreadyInstalled = 2,
    /// The rule is not scoped to a single contract.
    OnlyCallContractAllowed = 3,
    /// Anything other than `transfer(from, to, amount)`.
    NotAllowed = 4,
    /// The recipient is not in the seller registry.
    SellerNotVerified = 5,
}

#[contractevent]
#[derive(Clone, Debug)]
pub struct PaymentAuthorized {
    #[topic]
    pub smart_account: Address,
    #[topic]
    pub seller: Address,
    pub context_rule_id: u32,
    pub token: Address,
    pub amount: i128,
}

#[contract]
pub struct VerifiedSellerPolicy;

#[contractimpl]
impl Policy for VerifiedSellerPolicy {
    type AccountParams = VerifiedSellerParams;

    fn enforce(
        e: &Env,
        context: Context,
        authenticated_signers: Vec<Signer>,
        context_rule: ContextRule,
        smart_account: Address,
    ) {
        smart_account.require_auth();

        if authenticated_signers.is_empty() {
            panic_with_error!(e, VerifiedSellerError::NotAllowed)
        }

        let key = DataKey::Registry(smart_account.clone(), context_rule.id);
        let registry: Address = match e.storage().persistent().get(&key) {
            Some(registry) => registry,
            None => panic_with_error!(e, VerifiedSellerError::NotInstalled),
        };
        e.storage().persistent().extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);

        // Only SEP-41 `transfer(from, to, amount)` is allowed. `approve`,
        // `transfer_from` and everything else is rejected.
        let (token, seller, amount) = match &context {
            Context::Contract(ContractContext { contract, fn_name, args })
                if fn_name == &symbol_short!("transfer") =>
            {
                let seller = args.get(1).and_then(|v| Address::try_from_val(e, &v).ok());
                let amount = args.get(2).and_then(|v| i128::try_from_val(e, &v).ok());
                match (seller, amount) {
                    (Some(seller), Some(amount)) => (contract.clone(), seller, amount),
                    _ => panic_with_error!(e, VerifiedSellerError::NotAllowed),
                }
            }
            _ => panic_with_error!(e, VerifiedSellerError::NotAllowed),
        };

        if !SellerRegistryClient::new(e, &registry).is_verified(&seller) {
            panic_with_error!(e, VerifiedSellerError::SellerNotVerified)
        }

        PaymentAuthorized {
            smart_account,
            seller,
            context_rule_id: context_rule.id,
            token,
            amount,
        }
        .publish(e);
    }

    fn install(
        e: &Env,
        install_params: Self::AccountParams,
        context_rule: ContextRule,
        smart_account: Address,
    ) {
        smart_account.require_auth();

        if !matches!(context_rule.context_type, ContextRuleType::CallContract(_)) {
            panic_with_error!(e, VerifiedSellerError::OnlyCallContractAllowed)
        }

        let key = DataKey::Registry(smart_account, context_rule.id);
        if e.storage().persistent().has(&key) {
            panic_with_error!(e, VerifiedSellerError::AlreadyInstalled)
        }
        e.storage().persistent().set(&key, &install_params.registry);
    }

    fn uninstall(e: &Env, context_rule: ContextRule, smart_account: Address) {
        smart_account.require_auth();
        e.storage().persistent().remove(&DataKey::Registry(smart_account, context_rule.id));
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{testutils::Address as _, vec, IntoVal, String, Symbol};

    // Stand-in for the seller registry contract.
    #[contract]
    struct MockRegistry;

    #[contracttype]
    enum MockKey {
        Verified(Address),
    }

    #[contractimpl]
    impl MockRegistry {
        pub fn allow(e: Env, seller: Address) {
            e.storage().persistent().set(&MockKey::Verified(seller), &true);
        }

        pub fn is_verified(e: Env, seller: Address) -> bool {
            e.storage().persistent().has(&MockKey::Verified(seller))
        }
    }

    struct Setup {
        e: Env,
        policy: Address,
        registry: Address,
        account: Address,
        token: Address,
        rule: ContextRule,
        signers: Vec<Signer>,
    }

    fn setup() -> Setup {
        let e = Env::default();
        e.mock_all_auths();
        let policy = e.register(VerifiedSellerPolicy, ());
        let registry = e.register(MockRegistry, ());
        let account = Address::generate(&e);
        let token = Address::generate(&e);
        let rule = ContextRule {
            id: 1,
            context_type: ContextRuleType::CallContract(token.clone()),
            name: String::from_str(&e, "agent"),
            signers: Vec::new(&e),
            signer_ids: Vec::new(&e),
            policies: Vec::new(&e),
            policy_ids: Vec::new(&e),
            valid_until: None,
        };
        let signers = vec![&e, Signer::Delegated(Address::generate(&e))];
        VerifiedSellerPolicyClient::new(&e, &policy).install(
            &VerifiedSellerParams { registry: registry.clone() },
            &rule,
            &account,
        );
        Setup { e, policy, registry, account, token, rule, signers }
    }

    fn call(s: &Setup, fn_name: &str, to: &Address, amount: i128) -> Context {
        Context::Contract(ContractContext {
            contract: s.token.clone(),
            fn_name: Symbol::new(&s.e, fn_name),
            args: vec![&s.e, s.account.into_val(&s.e), to.into_val(&s.e), amount.into_val(&s.e)],
        })
    }

    #[test]
    fn allows_payment_to_verified_seller() {
        let s = setup();
        let seller = Address::generate(&s.e);
        MockRegistryClient::new(&s.e, &s.registry).allow(&seller);

        VerifiedSellerPolicyClient::new(&s.e, &s.policy).enforce(
            &call(&s, "transfer", &seller, 100),
            &s.signers,
            &s.rule,
            &s.account,
        );
    }

    #[test]
    fn rejects_payment_to_unverified_seller() {
        let s = setup();
        let impostor = Address::generate(&s.e);

        let result = VerifiedSellerPolicyClient::new(&s.e, &s.policy).try_enforce(
            &call(&s, "transfer", &impostor, 100),
            &s.signers,
            &s.rule,
            &s.account,
        );
        assert!(result.is_err());
    }

    #[test]
    fn rejects_anything_but_transfer() {
        let s = setup();
        let seller = Address::generate(&s.e);
        MockRegistryClient::new(&s.e, &s.registry).allow(&seller);

        let result = VerifiedSellerPolicyClient::new(&s.e, &s.policy).try_enforce(
            &call(&s, "approve", &seller, 100),
            &s.signers,
            &s.rule,
            &s.account,
        );
        assert!(result.is_err());
    }

    #[test]
    fn rejects_when_no_signer_authenticated() {
        let s = setup();
        let seller = Address::generate(&s.e);
        MockRegistryClient::new(&s.e, &s.registry).allow(&seller);

        let result = VerifiedSellerPolicyClient::new(&s.e, &s.policy).try_enforce(
            &call(&s, "transfer", &seller, 100),
            &Vec::new(&s.e),
            &s.rule,
            &s.account,
        );
        assert!(result.is_err());
    }
}
