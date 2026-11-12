use super::*;
use fee_manager::FeeManagerClient as FeeSetupClient;
use merchant_registry::MerchantRegistryClient;
use payment_router::{PaymentRouter, PaymentRouterClient};
use soroban_sdk::testutils::Address as _;
use soroban_sdk::token::{StellarAssetClient, TokenClient};
use soroban_sdk::Env;

struct World {
    env: Env,
    refunds: RefundManagerClient<'static>,
    router: PaymentRouterClient<'static>,
    token: Address,
    payer: Address,
    owner: Address,
    admin: Address,
    settlement: Address,
    payment_id: u64,
    refunds_id: Address,
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

    let registry_id = env.register(merchant_registry::MerchantRegistry, ());
    let registry = MerchantRegistryClient::new(&env, &registry_id);
    registry.initialize(&admin);
    let merchant_id = registry.register(&owner, &settlement, &string(&env, "Ledger Loom"), &200);
    registry.grant_role(&admin, &Role::Operator, &admin);
    registry.approve(&admin, &merchant_id);

    let fee_id = env.register(fee_manager::FeeManager, ());
    FeeSetupClient::new(&env, &fee_id).initialize(&admin, &treasury, &200);

    let router_id = env.register(PaymentRouter, ());
    let router = PaymentRouterClient::new(&env, &router_id);
    router.initialize(&admin, &registry_id, &fee_id, &treasury);

    let refund_id = env.register(RefundManager, ());
    let refunds = RefundManagerClient::new(&env, &refund_id);
    refunds.initialize(&admin, &router_id, &registry_id);
    // The refund manager is the component trusted to record refunds.
    router.grant_role(&admin, &Role::Operator, &refund_id);

    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token = sac.address();
    StellarAssetClient::new(&env, &token).mint(&payer, &100_000);

    let payment_id = router.create_payment(
        &payer,
        &merchant_id,
        &token,
        &10_000,
        &string(&env, "order-42"),
    );

    World {
        env,
        refunds,
        router,
        token,
        payer,
        owner,
        admin,
        settlement,
        payment_id,
        refunds_id: refund_id,
    }
}

#[test]
fn approved_refund_returns_funds_to_payer() {
    let w = world();
    let id = w
        .refunds
        .request(&w.payer, &w.payment_id, &4_000, &string(&w.env, "damaged"));
    assert_eq!(w.refunds.pending_count(), 1);
    assert_eq!(w.refunds.get(&id).status, RefundStatus::Pending);

    w.refunds.approve(&w.settlement, &id);
    assert_eq!(w.refunds.get(&id).status, RefundStatus::Approved);
    assert_eq!(w.refunds.pending_count(), 0);

    let token = TokenClient::new(&w.env, &w.token);
    assert_eq!(token.balance(&w.payer), 94_000);
    assert_eq!(token.balance(&w.settlement), 5_800);

    let payment = w.router.get_payment(&w.payment_id);
    assert_eq!(payment.refunded, 4_000);
    assert_eq!(
        payment.status,
        payment_router::PaymentStatus::PartiallyRefunded
    );
}

#[test]
fn rejected_refund_moves_no_funds() {
    let w = world();
    let id = w.refunds.request(
        &w.payer,
        &w.payment_id,
        &1_000,
        &string(&w.env, "changed mind"),
    );
    w.refunds
        .reject(&w.settlement, &id, &string(&w.env, "outside policy"));
    assert_eq!(w.refunds.get(&id).status, RefundStatus::Rejected);
    assert_eq!(w.refunds.pending_count(), 0);
    let token = TokenClient::new(&w.env, &w.token);
    assert_eq!(token.balance(&w.payer), 90_000);
    assert_eq!(token.balance(&w.settlement), 9_800);
}

#[test]
fn cannot_refund_more_than_payment() {
    let w = world();
    assert_eq!(
        w.refunds.try_request(
            &w.payer,
            &w.payment_id,
            &10_001,
            &string(&w.env, "too much")
        ),
        Err(Ok(Error::LimitExceeded))
    );
}

#[test]
fn only_payer_can_request() {
    let w = world();
    assert_eq!(
        w.refunds
            .try_request(&w.owner, &w.payment_id, &100, &string(&w.env, "x")),
        Err(Ok(Error::Unauthorized))
    );
}

#[test]
fn only_settlement_wallet_can_decide() {
    let w = world();
    let id = w
        .refunds
        .request(&w.payer, &w.payment_id, &100, &string(&w.env, "x"));
    let stranger = Address::generate(&w.env);
    assert_eq!(
        w.refunds.try_approve(&stranger, &id),
        Err(Ok(Error::Unauthorized))
    );
    assert_eq!(
        w.refunds.try_reject(&stranger, &id, &string(&w.env, "no")),
        Err(Ok(Error::Unauthorized))
    );
}

#[test]
fn refund_cannot_be_decided_twice() {
    let w = world();
    let id = w
        .refunds
        .request(&w.payer, &w.payment_id, &100, &string(&w.env, "x"));
    w.refunds.approve(&w.settlement, &id);
    assert_eq!(
        w.refunds.try_approve(&w.settlement, &id),
        Err(Ok(Error::InvalidState))
    );
    assert_eq!(
        w.refunds
            .try_reject(&w.settlement, &id, &string(&w.env, "no")),
        Err(Ok(Error::InvalidState))
    );
}

#[test]
fn reason_length_is_bounded() {
    let w = world();
    let long = String::from_str(
        &w.env,
        "0123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789",
    );
    assert_eq!(
        w.refunds.try_request(&w.payer, &w.payment_id, &100, &long),
        Err(Ok(Error::InvalidInput))
    );
}

#[test]
fn cumulative_refunds_cannot_exceed_payment() {
    let w = world();
    // Both requests are opened while the payment looks untouched, then the
    // first is paid out.
    let first = w
        .refunds
        .request(&w.payer, &w.payment_id, &6_000, &string(&w.env, "a"));
    let second = w
        .refunds
        .request(&w.payer, &w.payment_id, &6_000, &string(&w.env, "b"));
    assert_eq!(w.refunds.count(), 2);
    w.refunds.approve(&w.settlement, &first);

    // Only 4_000 of the payment is left, so the second approval must refuse.
    assert_eq!(
        w.refunds.try_approve(&w.settlement, &second),
        Err(Ok(Error::LimitExceeded))
    );
    assert_eq!(w.refunds.get(&second).status, RefundStatus::Pending);
}

#[test]
fn refund_manager_holds_router_operator_role() {
    let w = world();
    assert!(w.router.has_role(&Role::Operator, &w.refunds_id));
    let _ = &w.admin;
}
