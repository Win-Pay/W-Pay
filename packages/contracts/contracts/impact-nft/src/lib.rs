//! # ImpactNFT
//!
//! Soulbound achievement badges. Merchants and payers can be awarded a badge for
//! a milestone (first 1 000 payments, a completed impact campaign, ...). Badges
//! are non-transferable by construction: there is no transfer entry point and no
//! approval mechanism, so an `owner_of` result can only change through an admin
//! revocation.
//!
//! Security assumptions:
//! * Only an admin can mint or revoke.
//! * One badge per `(owner, kind)` pair, so a milestone cannot be double-awarded.
//! * Per-owner holdings are capped at [`MAX_PER_OWNER`] to keep the owner index
//!   bounded; the cap is an error, never a silent drop.
//! * `metadata` is an opaque 32-byte content hash. This contract stores no URIs
//!   and performs no off-chain fetches.

#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, BytesN, Env, Symbol, Vec,
};
use wpay_common::{access, Error, Role};

pub const MAX_PER_OWNER: u32 = 50;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Achievement {
    pub id: u64,
    pub owner: Address,
    pub kind: Symbol,
    pub metadata: BytesN<32>,
    pub minted_at: u64,
}

#[contracttype]
#[derive(Clone, Debug)]
pub enum DataKey {
    Achievement(u64),
    NextId,
    Owned(Address),
    HasKind(Address, Symbol),
    KindCount(Symbol),
    Total,
}

#[contract]
pub struct ImpactNFT;

#[contractimpl]
impl ImpactNFT {
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        access::init_admin(&env, &admin)?;
        env.storage().instance().set(&DataKey::NextId, &1u64);
        env.storage().instance().set(&DataKey::Total, &0u64);
        Ok(())
    }

    /// Awards a badge. One badge per owner and kind.
    pub fn mint(
        env: Env,
        caller: Address,
        to: Address,
        kind: Symbol,
        metadata: BytesN<32>,
    ) -> Result<u64, Error> {
        caller.require_auth();
        access::require_role(&env, Role::Admin, &caller)?;

        let kind_key = DataKey::HasKind(to.clone(), kind.clone());
        if env
            .storage()
            .persistent()
            .get::<DataKey, bool>(&kind_key)
            .unwrap_or(false)
        {
            return Err(Error::AlreadyExists);
        }

        let owned_key = DataKey::Owned(to.clone());
        let mut owned: Vec<u64> = env
            .storage()
            .persistent()
            .get(&owned_key)
            .unwrap_or_else(|| Vec::new(&env));
        if owned.len() >= MAX_PER_OWNER {
            return Err(Error::LimitExceeded);
        }

        let id: u64 = env.storage().instance().get(&DataKey::NextId).unwrap_or(1);
        let achievement = Achievement {
            id,
            owner: to.clone(),
            kind: kind.clone(),
            metadata,
            minted_at: env.ledger().timestamp(),
        };
        env.storage()
            .persistent()
            .set(&DataKey::Achievement(id), &achievement);
        env.storage().instance().set(&DataKey::NextId, &(id + 1));
        owned.push_back(id);
        env.storage().persistent().set(&owned_key, &owned);
        env.storage().persistent().set(&kind_key, &true);

        let count_key = DataKey::KindCount(kind.clone());
        let count: u64 = env.storage().persistent().get(&count_key).unwrap_or(0);
        env.storage().persistent().set(&count_key, &(count + 1));
        let total: u64 = env.storage().instance().get(&DataKey::Total).unwrap_or(0);
        env.storage().instance().set(&DataKey::Total, &(total + 1));

        env.events()
            .publish((symbol_short!("mint"), id), (to, kind));
        Ok(id)
    }

    /// Revokes a badge (compliance or a mistaken award). The id is retired.
    pub fn revoke(env: Env, caller: Address, id: u64) -> Result<(), Error> {
        caller.require_auth();
        access::require_role(&env, Role::Admin, &caller)?;
        let achievement = Self::get(env.clone(), id)?;

        let owned_key = DataKey::Owned(achievement.owner.clone());
        let owned: Vec<u64> = env
            .storage()
            .persistent()
            .get(&owned_key)
            .unwrap_or_else(|| Vec::new(&env));
        let mut kept = Vec::new(&env);
        for existing in owned.iter() {
            if existing != id {
                kept.push_back(existing);
            }
        }
        env.storage().persistent().set(&owned_key, &kept);
        env.storage().persistent().remove(&DataKey::HasKind(
            achievement.owner.clone(),
            achievement.kind.clone(),
        ));
        let count_key = DataKey::KindCount(achievement.kind.clone());
        let count: u64 = env.storage().persistent().get(&count_key).unwrap_or(0);
        env.storage()
            .persistent()
            .set(&count_key, &count.saturating_sub(1));
        let total: u64 = env.storage().instance().get(&DataKey::Total).unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::Total, &total.saturating_sub(1));
        env.storage().persistent().remove(&DataKey::Achievement(id));

        env.events()
            .publish((symbol_short!("revoke"), id), achievement.owner);
        Ok(())
    }

    pub fn get(env: Env, id: u64) -> Result<Achievement, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Achievement(id))
            .ok_or(Error::NotFound)
    }

    pub fn owner_of(env: Env, id: u64) -> Result<Address, Error> {
        Ok(Self::get(env, id)?.owner)
    }

    pub fn balance_of(env: Env, owner: Address) -> u32 {
        env.storage()
            .persistent()
            .get::<DataKey, Vec<u64>>(&DataKey::Owned(owner))
            .map(|owned| owned.len())
            .unwrap_or(0)
    }

    pub fn tokens_of(env: Env, owner: Address) -> Vec<u64> {
        env.storage()
            .persistent()
            .get(&DataKey::Owned(owner))
            .unwrap_or_else(|| Vec::new(&env))
    }

    pub fn has_kind(env: Env, owner: Address, kind: Symbol) -> bool {
        env.storage()
            .persistent()
            .get::<DataKey, bool>(&DataKey::HasKind(owner, kind))
            .unwrap_or(false)
    }

    pub fn total_minted(env: Env) -> u64 {
        env.storage().instance().get(&DataKey::Total).unwrap_or(0)
    }

    pub fn kind_count(env: Env, kind: Symbol) -> u64 {
        env.storage()
            .persistent()
            .get(&DataKey::KindCount(kind))
            .unwrap_or(0)
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
}

#[cfg(test)]
mod test;
