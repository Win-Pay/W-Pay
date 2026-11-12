//! # EscrowManager
//!
//! Holds a payer's funds until delivery is accepted or an arbiter resolves a
//! dispute. The contract is the custodian: funds sit at the contract address
//! until exactly one terminal transition releases them.
//!
//! ```text
//! create -> Funded --release--> Released
//!                 \--refund---> Refunded
//!                 \--dispute--> Disputed --resolve--> Released | Refunded
//! ```
//!
//! Security assumptions:
//! * `create` requires the payer's authorization and moves the full amount into
//!   the contract in the same transaction.
//! * The payer or the arbiter may release at any time; the payee may only claim
//!   after `release_at`, so a payer cannot be forced to wait forever and a payee
//!   cannot take funds before the agreed delivery date.
//! * Before `release_at` the payer may reclaim unilaterally; afterwards only the
//!   arbiter can refund, so a payee's earned funds cannot be pulled back.
//! * Resolving a dispute requires the arbiter recorded at creation time.
//! * Terminal states pay out once; every transition is guarded, so a re-entered
//!   or repeated call cannot drain the contract.

#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, symbol_short, Address, Env};
use wpay_common::{access, pause, tokens, validation, Error, Role};

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EscrowStatus {
    Funded,
    Released,
    Refunded,
    Disputed,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Escrow {
    pub id: u64,
    pub payer: Address,
    pub payee: Address,
    pub arbiter: Address,
    pub token: Address,
    pub amount: i128,
    pub release_at: u64,
    pub created_at: u64,
    pub status: EscrowStatus,
}

#[contracttype]
#[derive(Clone, Debug)]
pub enum DataKey {
    Escrow(u64),
    NextId,
    Count,
    Locked(Address),
}

#[contract]
pub struct EscrowManager;

#[contractimpl]
impl EscrowManager {
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        access::init_admin(&env, &admin)?;
        env.storage().instance().set(&DataKey::NextId, &1u64);
        Ok(())
    }

    /// Creates an escrow and pulls `amount` from the payer into the contract.
    /// Returns the escrow id.
    pub fn create(
        env: Env,
        payer: Address,
        payee: Address,
        arbiter: Address,
        token: Address,
        amount: i128,
        release_at: u64,
    ) -> Result<u64, Error> {
        pause::require_not_paused(&env)?;
        payer.require_auth();
        validation::require_positive(amount)?;
        if payer == payee || payer == arbiter || payee == arbiter {
            return Err(Error::InvalidInput);
        }

        tokens::transfer(
            &env,
            &token,
            &payer,
            &env.current_contract_address(),
            amount,
        );

        let id: u64 = env.storage().instance().get(&DataKey::NextId).unwrap_or(1);
        let escrow = Escrow {
            id,
            payer: payer.clone(),
            payee: payee.clone(),
            arbiter: arbiter.clone(),
            token: token.clone(),
            amount,
            release_at,
            created_at: env.ledger().timestamp(),
            status: EscrowStatus::Funded,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Escrow(id), &escrow);
        env.storage().instance().set(&DataKey::NextId, &(id + 1));
        let count: u64 = env.storage().instance().get(&DataKey::Count).unwrap_or(0);
        env.storage().instance().set(&DataKey::Count, &(count + 1));
        let locked: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::Locked(token.clone()))
            .unwrap_or(0);
        env.storage()
            .persistent()
            .set(&DataKey::Locked(token), &(locked + amount));

        env.events().publish(
            (symbol_short!("escrow"), id),
            (payer, payee, amount, release_at),
        );
        Ok(id)
    }

    /// Releases the escrow to the payee.
    ///
    /// Allowed for the payer or arbiter at any time, and for the payee once
    /// `release_at` has passed.
    pub fn release(env: Env, caller: Address, escrow_id: u64) -> Result<(), Error> {
        caller.require_auth();
        let mut escrow = Self::get(env.clone(), escrow_id)?;
        if escrow.status != EscrowStatus::Funded {
            return Err(Error::InvalidState);
        }
        let is_party = caller == escrow.payer || caller == escrow.arbiter;
        let payee_can_claim =
            caller == escrow.payee && env.ledger().timestamp() >= escrow.release_at;
        if !is_party && !payee_can_claim {
            return Err(Error::Unauthorized);
        }
        escrow.status = EscrowStatus::Released;
        Self::settle(&env, &escrow);
        env.events()
            .publish((symbol_short!("release"), escrow_id), caller);
        Ok(())
    }

    /// Returns the funds to the payer. The payer may do this before
    /// `release_at`; afterwards only the arbiter may.
    pub fn refund(env: Env, caller: Address, escrow_id: u64) -> Result<(), Error> {
        caller.require_auth();
        let mut escrow = Self::get(env.clone(), escrow_id)?;
        if escrow.status != EscrowStatus::Funded {
            return Err(Error::InvalidState);
        }
        let payer_before_release =
            caller == escrow.payer && env.ledger().timestamp() < escrow.release_at;
        if !payer_before_release && caller != escrow.arbiter {
            return Err(Error::Unauthorized);
        }
        escrow.status = EscrowStatus::Refunded;
        Self::settle(&env, &escrow);
        env.events()
            .publish((symbol_short!("refund"), escrow_id), caller);
        Ok(())
    }

    /// Flags a funded escrow as disputed. Either party may dispute; the funds
    /// stay locked until the arbiter resolves.
    pub fn dispute(env: Env, caller: Address, escrow_id: u64) -> Result<(), Error> {
        caller.require_auth();
        let mut escrow = Self::get(env.clone(), escrow_id)?;
        if escrow.status != EscrowStatus::Funded {
            return Err(Error::InvalidState);
        }
        if caller != escrow.payer && caller != escrow.payee {
            return Err(Error::Unauthorized);
        }
        escrow.status = EscrowStatus::Disputed;
        env.storage()
            .persistent()
            .set(&DataKey::Escrow(escrow_id), &escrow);
        env.events()
            .publish((symbol_short!("dispute"), escrow_id), caller);
        Ok(())
    }

    /// Arbiter-only resolution of a disputed escrow.
    pub fn resolve(
        env: Env,
        arbiter: Address,
        escrow_id: u64,
        release_to_payee: bool,
    ) -> Result<(), Error> {
        arbiter.require_auth();
        let mut escrow = Self::get(env.clone(), escrow_id)?;
        if escrow.status != EscrowStatus::Disputed {
            return Err(Error::InvalidState);
        }
        if arbiter != escrow.arbiter {
            return Err(Error::Unauthorized);
        }
        escrow.status = if release_to_payee {
            EscrowStatus::Released
        } else {
            EscrowStatus::Refunded
        };
        Self::settle(&env, &escrow);
        env.events().publish(
            (symbol_short!("resolve"), escrow_id),
            (arbiter, release_to_payee),
        );
        Ok(())
    }

    pub fn get(env: Env, id: u64) -> Result<Escrow, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Escrow(id))
            .ok_or(Error::NotFound)
    }

    /// Tokens currently held by the contract for `token`.
    pub fn locked(env: Env, token: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Locked(token))
            .unwrap_or(0)
    }

    pub fn count(env: Env) -> u64 {
        env.storage().instance().get(&DataKey::Count).unwrap_or(0)
    }

    pub fn grant_role(
        env: Env,
        caller: Address,
        role: Role,
        account: Address,
    ) -> Result<(), Error> {
        access::grant(&env, &caller, role, &account)
    }

    pub fn has_role(env: Env, role: Role, account: Address) -> bool {
        access::has_role(&env, role, &account)
    }

    pub fn set_pause_authority(env: Env, caller: Address, authority: Address) -> Result<(), Error> {
        pause::set_authority(&env, &caller, &authority)
    }

    pub fn set_paused(env: Env, caller: Address, paused: bool) -> Result<(), Error> {
        pause::set_paused(&env, &caller, paused)
    }

    pub fn is_paused(env: Env) -> bool {
        pause::is_paused(&env)
    }
}

impl EscrowManager {
    /// Persists the terminal status and pays out to the counterparty.
    /// Called only after the transition has been authorized.
    fn settle(env: &Env, escrow: &Escrow) {
        env.storage()
            .persistent()
            .set(&DataKey::Escrow(escrow.id), escrow);
        let locked: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::Locked(escrow.token.clone()))
            .unwrap_or(0);
        env.storage().persistent().set(
            &DataKey::Locked(escrow.token.clone()),
            &locked.saturating_sub(escrow.amount),
        );
        let recipient = match escrow.status {
            EscrowStatus::Released => escrow.payee.clone(),
            EscrowStatus::Refunded => escrow.payer.clone(),
            _ => return,
        };
        tokens::transfer(
            env,
            &escrow.token,
            &env.current_contract_address(),
            &recipient,
            escrow.amount,
        );
    }
}

#[cfg(test)]
mod test;
