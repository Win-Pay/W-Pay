//! # Governance
//!
//! Minimal on-chain governance for protocol parameter changes and upgrades: a
//! fixed electorate of members, one vote per member per proposal, an absolute
//! quorum on yes votes and a strict majority over no votes.
//!
//! Security assumptions:
//! * Membership is admin-managed and capped at [`MAX_MEMBERS`]; the electorate
//!   is defined on-chain and cannot be inflated by an attacker holding tokens.
//! * Only members may propose or vote, and a member can vote once per proposal.
//! * Voting closes strictly after `voting_ends`; `finalize` cannot run before
//!   that, and cannot run twice.
//! * A passed proposal only becomes `Executed` through an explicit admin call to
//!   `mark_executed`. Execution itself is out of scope (a timelock or the
//!   `UpgradeManager` performs it), so the governance contract never moves funds
//!   or installs code by itself.

#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, BytesN, Env, String, Vec,
};
use wpay_common::{access, Error, Role};

pub const MAX_MEMBERS: u32 = 100;
pub const MAX_DESCRIPTION_LEN: u32 = 256;

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProposalStatus {
    Active,
    Passed,
    Rejected,
    Executed,
    Cancelled,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Proposal {
    pub id: u64,
    pub proposer: Address,
    pub payload: BytesN<32>,
    pub description: String,
    pub created_at: u64,
    pub voting_ends: u64,
    pub for_votes: u32,
    pub against_votes: u32,
    pub status: ProposalStatus,
}

#[contracttype]
#[derive(Clone, Debug)]
pub enum DataKey {
    Proposal(u64),
    NextId,
    Members,
    Membership(Address),
    Vote(u64, Address),
    VotingPeriod,
    Quorum,
}

#[contract]
pub struct Governance;

#[contractimpl]
impl Governance {
    pub fn initialize(
        env: Env,
        admin: Address,
        voting_period_secs: u64,
        quorum: u32,
    ) -> Result<(), Error> {
        access::init_admin(&env, &admin)?;
        if voting_period_secs == 0 || quorum == 0 {
            return Err(Error::InvalidInput);
        }
        env.storage()
            .instance()
            .set(&DataKey::VotingPeriod, &voting_period_secs);
        env.storage().instance().set(&DataKey::Quorum, &quorum);
        env.storage().instance().set(&DataKey::NextId, &1u64);
        env.storage()
            .persistent()
            .set(&DataKey::Members, &Vec::<Address>::new(&env));
        Ok(())
    }

    pub fn add_member(env: Env, caller: Address, member: Address) -> Result<(), Error> {
        caller.require_auth();
        access::require_role(&env, Role::Admin, &caller)?;
        if env
            .storage()
            .persistent()
            .get::<DataKey, bool>(&DataKey::Membership(member.clone()))
            .unwrap_or(false)
        {
            return Err(Error::AlreadyExists);
        }
        let mut members = Self::members(env.clone());
        if members.len() >= MAX_MEMBERS {
            return Err(Error::LimitExceeded);
        }
        members.push_back(member.clone());
        env.storage().persistent().set(&DataKey::Members, &members);
        env.storage()
            .persistent()
            .set(&DataKey::Membership(member.clone()), &true);
        env.events()
            .publish((symbol_short!("member"),), (caller, member));
        Ok(())
    }

    pub fn remove_member(env: Env, caller: Address, member: Address) -> Result<(), Error> {
        caller.require_auth();
        access::require_role(&env, Role::Admin, &caller)?;
        if !env
            .storage()
            .persistent()
            .get::<DataKey, bool>(&DataKey::Membership(member.clone()))
            .unwrap_or(false)
        {
            return Err(Error::NotFound);
        }
        let members = Self::members(env.clone());
        let mut kept = Vec::new(&env);
        for existing in members.iter() {
            if existing != member {
                kept.push_back(existing);
            }
        }
        env.storage().persistent().set(&DataKey::Members, &kept);
        env.storage()
            .persistent()
            .remove(&DataKey::Membership(member.clone()));
        env.events()
            .publish((symbol_short!("unmember"),), (caller, member));
        Ok(())
    }

    pub fn propose(
        env: Env,
        proposer: Address,
        payload: BytesN<32>,
        description: String,
    ) -> Result<u64, Error> {
        proposer.require_auth();
        Self::require_member(&env, &proposer)?;
        if description.len() > MAX_DESCRIPTION_LEN {
            return Err(Error::InvalidInput);
        }
        let id: u64 = env.storage().instance().get(&DataKey::NextId).unwrap_or(1);
        let voting_period = Self::voting_period(env.clone());
        let proposal = Proposal {
            id,
            proposer: proposer.clone(),
            payload,
            description,
            created_at: env.ledger().timestamp(),
            voting_ends: env.ledger().timestamp() + voting_period,
            for_votes: 0,
            against_votes: 0,
            status: ProposalStatus::Active,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Proposal(id), &proposal);
        env.storage().instance().set(&DataKey::NextId, &(id + 1));
        env.events()
            .publish((symbol_short!("propose"), id), proposer);
        Ok(id)
    }

    pub fn vote(env: Env, voter: Address, proposal_id: u64, support: bool) -> Result<(), Error> {
        voter.require_auth();
        Self::require_member(&env, &voter)?;
        let mut proposal = Self::get(env.clone(), proposal_id)?;
        if proposal.status != ProposalStatus::Active {
            return Err(Error::InvalidState);
        }
        if env.ledger().timestamp() >= proposal.voting_ends {
            return Err(Error::InvalidState);
        }
        let vote_key = DataKey::Vote(proposal_id, voter.clone());
        if env
            .storage()
            .persistent()
            .get::<DataKey, bool>(&vote_key)
            .unwrap_or(false)
        {
            return Err(Error::AlreadyVoted);
        }
        env.storage().persistent().set(&vote_key, &true);
        if support {
            proposal.for_votes += 1;
        } else {
            proposal.against_votes += 1;
        }
        env.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal);
        env.events()
            .publish((symbol_short!("vote"), proposal_id), (voter, support));
        Ok(())
    }

    /// Closes voting and records the outcome. Anyone may call it.
    pub fn finalize(env: Env, proposal_id: u64) -> Result<ProposalStatus, Error> {
        let mut proposal = Self::get(env.clone(), proposal_id)?;
        if proposal.status != ProposalStatus::Active {
            return Err(Error::InvalidState);
        }
        if env.ledger().timestamp() < proposal.voting_ends {
            return Err(Error::InvalidState);
        }
        let quorum = Self::quorum(env.clone());
        proposal.status =
            if proposal.for_votes >= quorum && proposal.for_votes > proposal.against_votes {
                ProposalStatus::Passed
            } else {
                ProposalStatus::Rejected
            };
        env.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal);
        env.events()
            .publish((symbol_short!("finalize"), proposal_id), proposal.status);
        Ok(proposal.status)
    }

    /// Marks a passed proposal as executed, after the corresponding action has
    /// been carried out elsewhere.
    pub fn mark_executed(env: Env, caller: Address, proposal_id: u64) -> Result<(), Error> {
        caller.require_auth();
        access::require_role(&env, Role::Admin, &caller)?;
        let mut proposal = Self::get(env.clone(), proposal_id)?;
        if proposal.status != ProposalStatus::Passed {
            return Err(Error::InvalidState);
        }
        proposal.status = ProposalStatus::Executed;
        env.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal);
        Ok(())
    }

    pub fn cancel(env: Env, caller: Address, proposal_id: u64) -> Result<(), Error> {
        caller.require_auth();
        access::require_role(&env, Role::Admin, &caller)?;
        let mut proposal = Self::get(env.clone(), proposal_id)?;
        if proposal.status == ProposalStatus::Executed
            || proposal.status == ProposalStatus::Cancelled
        {
            return Err(Error::InvalidState);
        }
        proposal.status = ProposalStatus::Cancelled;
        env.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal);
        env.events()
            .publish((symbol_short!("cancel"), proposal_id), caller);
        Ok(())
    }

    pub fn get(env: Env, id: u64) -> Result<Proposal, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Proposal(id))
            .ok_or(Error::NotFound)
    }

    pub fn has_voted(env: Env, proposal_id: u64, voter: Address) -> bool {
        env.storage()
            .persistent()
            .get::<DataKey, bool>(&DataKey::Vote(proposal_id, voter))
            .unwrap_or(false)
    }

    pub fn members(env: Env) -> Vec<Address> {
        env.storage()
            .persistent()
            .get(&DataKey::Members)
            .unwrap_or_else(|| Vec::new(&env))
    }

    pub fn member_count(env: Env) -> u32 {
        Self::members(env).len()
    }

    pub fn is_member(env: Env, who: Address) -> bool {
        env.storage()
            .persistent()
            .get::<DataKey, bool>(&DataKey::Membership(who))
            .unwrap_or(false)
    }

    pub fn proposal_count(env: Env) -> u64 {
        env.storage().instance().get(&DataKey::NextId).unwrap_or(1) - 1
    }

    pub fn voting_period(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::VotingPeriod)
            .unwrap_or(0)
    }

    pub fn quorum(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::Quorum).unwrap_or(0)
    }

    pub fn grant_role(
        env: Env,
        caller: Address,
        role: Role,
        account: Address,
    ) -> Result<(), Error> {
        access::grant(&env, &caller, role, &account)
    }
}

impl Governance {
    fn require_member(env: &Env, who: &Address) -> Result<(), Error> {
        if !env
            .storage()
            .persistent()
            .get::<DataKey, bool>(&DataKey::Membership(who.clone()))
            .unwrap_or(false)
        {
            return Err(Error::Unauthorized);
        }
        Ok(())
    }
}

#[cfg(test)]
mod test;
