use super::*;
use fee_manager::FeeManagerClient as FeeSetupClient;
use merchant_registry::MerchantRegistryClient;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::token::{StellarAssetClient, TokenClient};
use soroban_sdk::Env;
use wpay_common::Merchant;

struct World {
    env: Env,
    router: PaymentRouterClient<'static>,
    registry: MerchantRegistryClient<'static>,
    fee: FeeSetupClient<'static>,
    token: Address,
    payer: Address,
    treasury: Address,
    admin: Address,
    owner: Address,
    merchant_id: u64,
    settlement: Address,
}

fn string(env: &Env, s: &str) -> String {
    String::from_str(env, s)
}

fn world() -> World {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let payer = Address::generate(&env);
    let owner = Address::generate(&env);
    let settlement = Address::generate(&env);

    // Real dependencies: a merchant registry and a fee manager.
    let registry_id = env.register(merchant_registry::MerchantRegistry, ());
    let registry = MerchantRegistryClient::new(&env, &registry_id);
    registry.initialize(&admin);
    let merchant_id = registry.register(&owner, &settlement, &string(&env, "Harbor"), &250);
    registry.grant_role(&admin, &Role::Operator, &admin);
    registry.approve(&admin, &merchant_id);

    let fee_id = env.register(fee_manager::FeeManager, ());
    let fee = FeeSetupClient::new(&env, &fee_id);
    fee.initialize(&admin, &treasury, &250);

    let router_id = env.register(PaymentRouter, ());
    let router = PaymentRouterClient::new(&env, &router_id);
    router.initialize(&admin, &registry_id, &fee_id, &treasury);

    // A Stellar Asset Contract stands in for USDC-like value in tests.
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token = sac.address();
    StellarAssetClient::new(&env, &token).mint(&payer, &100_000);

    World {
        env,
        router,
        registry,
        fee,
        token,
        payer,
        treasury,
        admin,
        owner,
        merchant_id,
        settlement,
    }
}

#[test]
fn payment_splits_fee_and_net() {
    let w = world();
    let payment_id = w.router.create_payment(
        &w.payer,
        &w.merchant_id,
        &w.token,
        &10_000,
        &string(&w.env, "order-1"),
    );

    let payment = w.router.get_payment(&payment_id);
    assert_eq!(payment.amount, 10_000);
    assert_eq!(payment.fee, 250);
    assert_eq!(payment.net, 9_750);
    assert_eq!(payment.refunded, 0);
    assert_eq!(payment.status, PaymentStatus::Settled);

    let token = TokenClient::new(&w.env, &w.token);
    assert_eq!(token.balance(&w.treasury), 250);
    assert_eq!(token.balance(&w.settlement), 9_750);
    assert_eq!(token.balance(&w.payer), 90_000);
    assert_eq!(w.router.volume(&w.merchant_id), 10_000);
}

#[test]
fn merchant_specific_fee_is_used() {
    let w = world();
    // The fee manager override for the merchant owner must win.
    w.fee.set_merchant_fee(&w.admin, &w.owner, &Some(0));
    assert_eq!(w.fee.calculate(&w.owner, &1_000).fee, 0);

    let payment_id = w.router.create_payment(
        &w.payer,
        &w.merchant_id,
        &w.token,
        &1_000,
        &String::from_str(&w.env, ""),
    );
    let payment = w.router.get_payment(&payment_id);
    assert_eq!(payment.fee, 0);
    assert_eq!(payment.net, 1_000);
}

#[test]
fn inactive_merchant_is_rejected() {
    let w = world();
    let frozen = w.registry.register(
        &Address::generate(&w.env),
        &Address::generate(&w.env),
        &string(&w.env, "Unapproved"),
        &100,
    );
    assert_eq!(
        w.router.try_create_payment(
            &w.payer,
            &frozen,
            &w.token,
            &1_000,
            &String::from_str(&w.env, "")
        ),
        Err(Ok(Error::InvalidState))
    );
}

#[test]
fn zero_and_negative_amounts_rejected() {
    let w = world();
    let memo = String::from_str(&w.env, "");
    assert_eq!(
        w.router
            .try_create_payment(&w.payer, &w.merchant_id, &w.token, &0, &memo),
        Err(Ok(Error::InvalidInput))
    );
    assert_eq!(
        w.router
            .try_create_payment(&w.payer, &w.merchant_id, &w.token, &-1, &memo),
        Err(Ok(Error::InvalidInput))
    );
}

#[test]
fn memo_length_is_bounded() {
    let w = world();
    let long = String::from_str(
        &w.env,
        "0123456789012345678901234567890123456789012345678901234567890123456789",
    );
    assert_eq!(
        w.router
            .try_create_payment(&w.payer, &w.merchant_id, &w.token, &100, &long),
        Err(Ok(Error::InvalidInput))
    );
}

#[test]
fn refunds_accumulate_and_cannot_exceed_amount() {
    let w = world();
    let admin = w.admin.clone();
    w.router.grant_role(&admin, &Role::Operator, &admin);

    let id = w.router.create_payment(
        &w.payer,
        &w.merchant_id,
        &w.token,
        &10_000,
        &String::from_str(&w.env, ""),
    );

    assert_eq!(w.router.record_refund(&admin, &id, &4_000), 4_000);
    assert_eq!(
        w.router.get_payment(&id).status,
        PaymentStatus::PartiallyRefunded
    );
    assert_eq!(w.router.record_refund(&admin, &id, &6_000), 10_000);
    assert_eq!(w.router.get_payment(&id).status, PaymentStatus::Refunded);
    assert_eq!(
        w.router.try_record_refund(&admin, &id, &1),
        Err(Ok(Error::LimitExceeded))
    );
}

#[test]
fn refund_requires_operator_role() {
    let w = world();
    let id = w.router.create_payment(
        &w.payer,
        &w.merchant_id,
        &w.token,
        &1_000,
        &String::from_str(&w.env, ""),
    );
    let stranger = Address::generate(&w.env);
    assert_eq!(
        w.router.try_record_refund(&stranger, &id, &100),
        Err(Ok(Error::Unauthorized))
    );
    assert_eq!(
        w.router
            .try_record_refund(&Address::generate(&w.env), &id, &0),
        Err(Ok(Error::Unauthorized))
    );
}

#[test]
fn paused_router_rejects_payments() {
    let w = world();
    let admin = w.admin.clone();
    w.router.grant_role(&admin, &Role::Admin, &admin);
    w.router.set_paused(&admin, &true);
    assert!(w.router.is_paused());
    assert_eq!(
        w.router.try_create_payment(
            &w.payer,
            &w.merchant_id,
            &w.token,
            &1_000,
            &String::from_str(&w.env, "")
        ),
        Err(Ok(Error::Paused))
    );
}

#[test]
fn uninitialized_dependencies_are_explicit_errors() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let id = env.register(PaymentRouter, ());
    let router = PaymentRouterClient::new(&env, &id);
    router.initialize(&admin, &admin, &admin, &admin);
    // Registry address points at a non-contract account: the call traps rather
    // than silently succeeding, which is the desired failure mode.
    let result = router.try_create_payment(&admin, &1, &admin, &100, &String::from_str(&env, ""));
    assert!(result.is_err());
}
