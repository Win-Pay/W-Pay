use super::*;
use fee_manager::FeeManagerClient as FeeSetupClient;
use merchant_registry::MerchantRegistryClient;
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::token::{StellarAssetClient, TokenClient};
use soroban_sdk::{Env, String};

struct World {
    env: Env,
    subs: SubscriptionManagerClient<'static>,
    token: Address,
    subscriber: Address,
    owner: Address,
    settlement: Address,
    treasury: Address,
    merchant_id: u64,
    plan_id: u64,
}

fn string(env: &Env, s: &str) -> String {
    String::from_str(env, s)
}

fn world() -> World {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let owner = Address::generate(&env);
    let settlement = Address::generate(&env);
    let subscriber = Address::generate(&env);

    let registry_id = env.register(merchant_registry::MerchantRegistry, ());
    let registry = MerchantRegistryClient::new(&env, &registry_id);
    registry.initialize(&admin);
    let merchant_id = registry.register(&owner, &settlement, &string(&env, "Streamline"), &200);
    registry.grant_role(&admin, &Role::Operator, &admin);
    registry.approve(&admin, &merchant_id);

    let fee_id = env.register(fee_manager::FeeManager, ());
    FeeSetupClient::new(&env, &fee_id).initialize(&admin, &treasury, &200);

    let sub_id = env.register(SubscriptionManager, ());
    let subs = SubscriptionManagerClient::new(&env, &sub_id);
    subs.initialize(&admin, &registry_id, &fee_id);

    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token = sac.address();
    StellarAssetClient::new(&env, &token).mint(&subscriber, &10_000);

    let plan_id = subs.create_plan(&owner, &merchant_id, &token, &1_000, &100);

    World {
        env,
        subs,
        token,
        subscriber,
        owner,
        settlement,
        treasury,
        merchant_id,
        plan_id,
    }
}

#[test]
fn subscribe_charges_first_cycle() {
    let w = world();
    let id = w.subs.subscribe(&w.subscriber, &w.plan_id, &3);
    let sub = w.subs.get_subscription(&id);

    assert_eq!(sub.prepaid, 2_000);
    assert_eq!(sub.cycles_charged, 1);
    assert_eq!(sub.next_due, 1_100);
    assert_eq!(sub.status, SubscriptionStatus::Active);
    assert_eq!(w.subs.held(&w.token), 2_000);

    let token = TokenClient::new(&w.env, &w.token);
    assert_eq!(token.balance(&w.subscriber), 7_000);
    assert_eq!(token.balance(&w.treasury), 20);
    assert_eq!(token.balance(&w.settlement), 980);
}

#[test]
fn charge_requires_due_date() {
    let w = world();
    let id = w.subs.subscribe(&w.subscriber, &w.plan_id, &3);
    assert!(!w.subs.is_due(&id));
    assert_eq!(w.subs.try_charge(&id), Err(Ok(Error::InvalidState)));

    w.env.ledger().set_timestamp(1_100);
    assert!(w.subs.is_due(&id));
    // Permissionless: anyone may advance a due cycle.
    let keeper = Address::generate(&w.env);
    let _ = keeper;
    w.subs.charge(&id);
    let sub = w.subs.get_subscription(&id);
    assert_eq!(sub.cycles_charged, 2);
    assert_eq!(sub.prepaid, 1_000);
    assert_eq!(sub.next_due, 1_200);
    assert_eq!(
        TokenClient::new(&w.env, &w.token).balance(&w.settlement),
        1_960
    );
}

#[test]
fn cancel_refunds_unused_prepayment() {
    let w = world();
    let id = w.subs.subscribe(&w.subscriber, &w.plan_id, &3);
    let refunded = w.subs.cancel(&w.subscriber, &id);
    assert_eq!(refunded, 2_000);
    assert_eq!(
        w.subs.get_subscription(&id).status,
        SubscriptionStatus::Cancelled
    );
    assert_eq!(w.subs.held(&w.token), 0);
    assert_eq!(
        TokenClient::new(&w.env, &w.token).balance(&w.subscriber),
        9_000
    );
    assert_eq!(
        w.subs.try_cancel(&w.subscriber, &id),
        Err(Ok(Error::InvalidState))
    );
}

#[test]
fn subscription_lapses_when_prepayment_runs_out() {
    let w = world();
    let id = w.subs.subscribe(&w.subscriber, &w.plan_id, &1);
    assert_eq!(
        w.subs.get_subscription(&id).status,
        SubscriptionStatus::Lapsed
    );
    assert_eq!(w.subs.held(&w.token), 0);
    w.env.ledger().set_timestamp(1_100);
    assert!(!w.subs.is_due(&id));
    assert_eq!(w.subs.try_charge(&id), Err(Ok(Error::InvalidState)));
}

#[test]
fn only_merchant_owner_creates_plans() {
    let w = world();
    assert_eq!(
        w.subs.try_create_plan(
            &Address::generate(&w.env),
            &w.merchant_id,
            &w.token,
            &100,
            &100
        ),
        Err(Ok(Error::Unauthorized))
    );
}

#[test]
fn zero_interval_and_zero_cycles_rejected() {
    let w = world();
    assert_eq!(
        w.subs
            .try_create_plan(&w.owner, &w.merchant_id, &w.token, &100, &0),
        Err(Ok(Error::InvalidInput))
    );
    assert_eq!(
        w.subs.try_subscribe(&w.subscriber, &w.plan_id, &0),
        Err(Ok(Error::InvalidInput))
    );
}

#[test]
fn paused_plan_cannot_be_subscribed() {
    let w = world();
    w.subs.set_plan_active(&w.owner, &w.plan_id, &false);
    assert_eq!(
        w.subs.try_subscribe(&w.subscriber, &w.plan_id, &1),
        Err(Ok(Error::InvalidState))
    );
}

#[test]
fn only_subscriber_can_cancel() {
    let w = world();
    let id = w.subs.subscribe(&w.subscriber, &w.plan_id, &3);
    assert_eq!(
        w.subs.try_cancel(&Address::generate(&w.env), &id),
        Err(Ok(Error::Unauthorized))
    );
}

#[test]
fn prepayment_overflow_is_an_error() {
    let w = world();
    assert!(w
        .subs
        .try_subscribe(&w.subscriber, &w.plan_id, &u32::MAX)
        .is_err());
}
