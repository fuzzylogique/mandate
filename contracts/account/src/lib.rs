//! Mandate smart account.
//!
//! Holds the owner's payment assets. The owner controls the default rule; each mandate
//! gets a context rule scoped to one token contract, with a spending
//! limit policy and the verified-seller policy attached.
//!
//! Adapted from OpenZeppelin's `multisig-smart-account` example (MIT):
//! https://github.com/OpenZeppelin/stellar-contracts/tree/main/examples/multisig-smart-account
#![no_std]
#![allow(unused_imports)]

use soroban_sdk::{
    auth::{Context, CustomAccountInterface},
    contract, contractimpl,
    crypto::Hash,
    Address, BytesN, Env, Map, String, Symbol, Val, Vec,
};
use stellar_accounts::smart_account::{
    self, AuthDigestPreimage, AuthPayload, ContextRule, ContextRuleType, ExecutionEntryPoint,
    Signer, SmartAccount, SmartAccountError,
};

#[contract]
pub struct MandateAccount;

#[contractimpl]
impl MandateAccount {
    /// Creates the owner's default context rule.
    ///
    /// * `name` - label for the rule, at most 20 bytes (e.g. "owner")
    /// * `signers` - the owner's signer(s)
    /// * `policies` - policy address -> install params; empty for the owner
    pub fn __constructor(e: &Env, name: String, signers: Vec<Signer>, policies: Map<Address, Val>) {
        smart_account::add_context_rule(
            e,
            &ContextRuleType::Default,
            &name,
            None,
            &signers,
            &policies,
        );
    }
}

#[contractimpl]
impl CustomAccountInterface for MandateAccount {
    type Error = SmartAccountError;
    type Signature = AuthPayload;

    /// Called by the host whenever this account must authorize something.
    /// Checks the signatures against the selected context rules, then runs
    /// every policy on those rules.
    fn __check_auth(
        e: Env,
        signature_payload: Hash<32>,
        signatures: AuthPayload,
        auth_contexts: Vec<Context>,
    ) -> Result<(), Self::Error> {
        smart_account::do_check_auth(&e, &signature_payload, &signatures, &auth_contexts)
    }
}

// Rule, signer and policy management (add_context_rule, remove_context_rule,
// add_policy, ...). Every call requires the account's own authorization, so
// only the owner's default rule can create or revoke a mandate.
#[contractimpl(contracttrait)]
impl SmartAccount for MandateAccount {}

#[contractimpl(contracttrait)]
impl ExecutionEntryPoint for MandateAccount {}
