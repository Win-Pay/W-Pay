//! # SubscriptionManager
//!
//! Prepaid recurring billing. On-chain recurring charges cannot pull from a
//! subscriber's wallet on a schedule (the subscriber is not present to sign), so
//! subscriptions are prepaid: the subscriber deposits N cycles into the
//! contract up front and a permissionless keeper advances each cycle.
//!
//! ```text
//! subscribe --(prepaid balance)--> Active --charge--> Active ... --balance low--> Lapsed
//!                                     \--cancel--> Cancelled (unused balance refunded)
//! ```
//!
//! Security assumptions:
//! * Only the merchant owner (per `MerchantRegistry`) creates plans for that
//!   merchant, and only an `Active` merchant may.
//! * Subscribing requires the subscriber's authorization and moves the full
//!   prepayment into the contract.
//! * `charge` is permissionless by design: it can only ever pay the merchant and
//!   treasury at the plan's fixed price, and only once per interval.
//! * Fees come from `FeeManager` at charge time, so a fee change applies to
//!   future cycles rather than rewriting past ones.
//! * Cancelling refunds the unspent prepayment to the subscriber, so the
//!   contract never keeps funds it is not owed.

#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, symbol_short, Address, Env};
use wpay_common::{
    access, pause, tokens, validation, Error, FeeManagerClient, FeeSplit, Merchant, MerchantStatus,
    RegistryClient, Role,
};

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SubscriptionStatus {
    Active,
    Cancelled,
    Lapsed,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Plan {
    pub id: u64,
    pub merchant_id: u64,
    pub owner: Address,
    pub token: Address,
    pub amount: i128,
    pub interval_secs: u64,
    pub active: bool,
    pub created_at: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Subscription {
    pub id: u64,
    pub plan_id: u64,
    pub subscriber: Address,
    pub prepaid: i128,
    pub cycles_charged: u32,
    pub next_due: u64,
    pub status: SubscriptionStatus,
}

#[contracttype]
#[derive(Clone, Debug)]
pub enum DataKey {
    Plan(u64),
    NextPlanId,
    Subscription(u64),
    NextSubId,
    Held(Address),
    Registry,
    FeeManager,
}

#[contract]
pub struct SubscriptionManager;

#[contractimpl]
impl SubscriptionManager {
    pub fn initialize(
        env: Env,
        admin: Address,
        registry: Address,
        fee_manager: Address,
    ) -> Result<(), Error> {
        access::init_admin(&env, &admin)?;
        env.storage().instance().set(&DataKey::Registry, &registry);
        env.storage()
            .instance()
            .set(&DataKey::FeeManager, &fee_manager);
        env.storage().instance().set(&DataKey::NextPlanId, &1u64);
        env.storage().instance().set(&DataKey::NextSubId, &1u64);
        Ok(())
    }

    /// Creates a plan for an active merchant.
    pub fn create_plan(
        env: Env,
        owner: Address,
        merchant_id: u64,
        token: Address,
        amount: i128,
        interval_secs: u64,
    ) -> Result<u64, Error> {
        pause::require_not_paused(&env)?;
        owner.require_auth();
        validation::require_positive(amount)?;
        if interval_secs == 0 {
            return Err(Error::InvalidInput);
        }
        let registry = Self::registry(env.clone())?;
        let merchant: Merchant = RegistryClient::new(&env, &registry).get(&merchant_id);
        if merchant.owner != owner {
            return Err(Error::Unauthorized);
        }
        if merchant.status != MerchantStatus::Active {
            return Err(Error::InvalidState);
        }

        let id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextPlanId)
            .unwrap_or(1);
        let plan = Plan {
            id,
            merchant_id,
            owner,
            token,
            amount,
            interval_secs,
            active: true,
            created_at: env.ledger().timestamp(),
        };
        env.storage().persistent().set(&DataKey::Plan(id), &plan);
        env.storage()
            .instance()
            .set(&DataKey::NextPlanId, &(id + 1));
        env.events()
            .publish((symbol_short!("plan"), id), (merchant_id, amount));
        Ok(id)
    }

    /// Subscribes for `cycles` prepaid cycles. Charges the first cycle
    /// immediately.
    pub fn subscribe(
        env: Env,
        subscriber: Address,
        plan_id: u64,
        cycles: u32,
    ) -> Result<u64, Error> {
        pause::require_not_paused(&env)?;
        subscriber.require_auth();
        if cycles == 0 {
            return Err(Error::InvalidInput);
        }
        let plan = Self::get_plan(env.clone(), plan_id)?;
        if !plan.active {
            return Err(Error::InvalidState);
        }
        let registry = Self::registry(env.clone())?;
        let merchant: Merchant = RegistryClient::new(&env, &registry).get(&plan.merchant_id);
        if merchant.status != MerchantStatus::Active {
            return Err(Error::InvalidState);
        }

        let total = plan
            .amount
            .checked_mul(cycles as i128)
            .ok_or(Error::InvalidInput)?;
        tokens::transfer(
            &env,
            &plan.token,
            &subscriber,
            &env.current_contract_address(),
            total,
        );

        let id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextSubId)
            .unwrap_or(1);
        let now = env.ledger().timestamp();
        let mut subscription = Subscription {
            id,
            plan_id,
            subscriber: subscriber.clone(),
            prepaid: total,
            cycles_charged: 0,
            // The immediate first charge below advances this by one interval.
            next_due: now,
            status: SubscriptionStatus::Active,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Subscription(id), &subscription);
        env.storage().instance().set(&DataKey::NextSubId, &(id + 1));
        let held_key = DataKey::Held(plan.token.clone());
        let held: i128 = env.storage().persistent().get(&held_key).unwrap_or(0);
        env.storage().persistent().set(&held_key, &(held + total));

        // First cycle is charged immediately; the subscription is only created
        // if that charge succeeds.
        Self::charge_cycle(&env, &mut subscription, &plan, &merchant)?;
        env.events().publish(
            (symbol_short!("subscribe"), id),
            (plan_id, subscriber, cycles),
        );
        Ok(id)
    }

    /// Advances one due cycle. Permissionless; the fixed plan price and the
    /// interval check bound what it can do.
    pub fn charge(env: Env, subscription_id: u64) -> Result<i128, Error> {
        let mut subscription = Self::get_subscription(env.clone(), subscription_id)?;
        if subscription.status != SubscriptionStatus::Active {
            return Err(Error::InvalidState);
        }
        if env.ledger().timestamp() < subscription.next_due {
            return Err(Error::InvalidState);
        }
        let plan = Self::get_plan(env.clone(), subscription.plan_id)?;
        if !plan.active {
            return Err(Error::InvalidState);
        }
        let registry = Self::registry(env.clone())?;
        let merchant: Merchant = RegistryClient::new(&env, &registry).get(&plan.merchant_id);
        if merchant.status != MerchantStatus::Active {
            return Err(Error::InvalidState);
        }
        Self::charge_cycle(&env, &mut subscription, &plan, &merchant)?;
        env.events().publish(
            (symbol_short!("charge"), subscription_id),
            (subscription.cycles_charged, plan.amount),
        );
        Ok(plan.amount)
    }

    /// Cancels and refunds the unspent prepayment to the subscriber.
    pub fn cancel(env: Env, subscriber: Address, subscription_id: u64) -> Result<i128, Error> {
        subscriber.require_auth();
        let mut subscription = Self::get_subscription(env.clone(), subscription_id)?;
        if subscription.subscriber != subscriber {
            return Err(Error::Unauthorized);
        }
        if subscription.status == SubscriptionStatus::Cancelled {
            return Err(Error::InvalidState);
        }
        let plan = Self::get_plan(env.clone(), subscription.plan_id)?;
        let refund = subscription.prepaid;
        subscription.prepaid = 0;
        subscription.status = SubscriptionStatus::Cancelled;
        env.storage()
            .persistent()
            .set(&DataKey::Subscription(subscription_id), &subscription);
        if refund > 0 {
            Self::release_held(&env, &plan.token, refund);
            tokens::transfer(
                &env,
                &plan.token,
                &env.current_contract_address(),
                &subscriber,
                refund,
            );
        }
        env.events().publish(
            (symbol_short!("cancel"), subscription_id),
            (subscriber, refund),
        );
        Ok(refund)
    }

    /// Pauses or resumes new subscriptions on a plan.
    pub fn set_plan_active(
        env: Env,
        owner: Address,
        plan_id: u64,
        active: bool,
    ) -> Result<(), Error> {
        owner.require_auth();
        let mut plan = Self::get_plan(env.clone(), plan_id)?;
        if plan.owner != owner {
            return Err(Error::Unauthorized);
        }
        plan.active = active;
        env.storage()
            .persistent()
            .set(&DataKey::Plan(plan_id), &plan);
        env.events()
            .publish((symbol_short!("planact"), plan_id), (owner, active));
        Ok(())
    }

    pub fn get_plan(env: Env, id: u64) -> Result<Plan, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Plan(id))
            .ok_or(Error::NotFound)
    }

    pub fn get_subscription(env: Env, id: u64) -> Result<Subscription, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Subscription(id))
            .ok_or(Error::NotFound)
    }

    /// True when a charge can be submitted right now.
    pub fn is_due(env: Env, id: u64) -> bool {
        match Self::get_subscription(env.clone(), id) {
            Ok(sub) => {
                sub.status == SubscriptionStatus::Active && env.ledger().timestamp() >= sub.next_due
            }
            Err(_) => false,
        }
    }

    pub fn held(env: Env, token: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Held(token))
            .unwrap_or(0)
    }

    pub fn next_plan_id(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::NextPlanId)
            .unwrap_or(1)
    }

    pub fn registry(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Registry)
            .ok_or(Error::NotInitialized)
    }

    pub fn fee_manager(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::FeeManager)
            .ok_or(Error::NotInitialized)
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

impl SubscriptionManager {
    fn charge_cycle(
        env: &Env,
        subscription: &mut Subscription,
        plan: &Plan,
        merchant: &Merchant,
    ) -> Result<(), Error> {
        if subscription.prepaid < plan.amount {
            subscription.status = SubscriptionStatus::Lapsed;
            env.storage()
                .persistent()
                .set(&DataKey::Subscription(subscription.id), subscription);
            return Err(Error::InsufficientFunds);
        }

        let fee_manager = env
            .storage()
            .instance()
            .get::<DataKey, Address>(&DataKey::FeeManager)
            .ok_or(Error::NotInitialized)?;
        let FeeSplit { fee, net } =
            FeeManagerClient::new(env, &fee_manager).calculate(&merchant.owner, &plan.amount);

        tokens::transfer(
            env,
            &plan.token,
            &env.current_contract_address(),
            &merchant.settlement,
            net,
        );
        if fee > 0 {
            // The treasury is the fee manager's configured address, read from
            // the single source of fee policy.
            let treasury = FeeManagerClient::new(env, &fee_manager).treasury();
            tokens::transfer(
                env,
                &plan.token,
                &env.current_contract_address(),
                &treasury,
                fee,
            );
        }

        subscription.prepaid -= plan.amount;
        subscription.cycles_charged += 1;
        subscription.next_due = subscription
            .next_due
            .checked_add(plan.interval_secs)
            .ok_or(Error::InvalidInput)?;
        if subscription.prepaid < plan.amount {
            subscription.status = SubscriptionStatus::Lapsed;
        }
        env.storage()
            .persistent()
            .set(&DataKey::Subscription(subscription.id), subscription);
        Self::release_held_static(env, &plan.token, plan.amount);
        Ok(())
    }

    fn release_held(env: &Env, token: &Address, amount: i128) {
        Self::release_held_static(env, token, amount);
    }

    fn release_held_static(env: &Env, token: &Address, amount: i128) {
        let held: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::Held(token.clone()))
            .unwrap_or(0);
        env.storage()
            .persistent()
            .set(&DataKey::Held(token.clone()), &held.saturating_sub(amount));
    }
}

#[cfg(test)]
mod test;
