use super::*;
use fee_manager::FeeManagerClient as FeeSetupClient;
use merchant_registry::MerchantRegistryClient;
use payment_router::{PaymentRouter, PaymentRouterClient};
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::token::{StellarAssetClient, TokenClient};
use soroban_sdk::Env;

struct World {
    env: Env,
    invoices: InvoiceManagerClient<'static>,
    router: PaymentRouterClient<'static>,
    token: Address,
    payer: Address,
    owner: Address,
    admin: Address,
    merchant_id: u64,
    settlement: Address,
    treasury: Address,
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
    let payer = Address::generate(&env);
    let owner = Address::generate(&env);
    let settlement = Address::generate(&env);

    let registry_id = env.register(merchant_registry::MerchantRegistry, ());
    let registry = MerchantRegistryClient::new(&env, &registry_id);
    registry.initialize(&admin);
    let merchant_id = registry.register(&owner, &settlement, &string(&env, "Cobalt"), &200);
    registry.grant_role(&admin, &Role::Operator, &admin);
    registry.approve(&admin, &merchant_id);

    let fee_id = env.register(fee_manager::FeeManager, ());
    FeeSetupClient::new(&env, &fee_id).initialize(&admin, &treasury, &200);

    let router_id = env.register(PaymentRouter, ());
    let router = PaymentRouterClient::new(&env, &router_id);
    router.initialize(&admin, &registry_id, &fee_id, &treasury);

    let invoice_id = env.register(InvoiceManager, ());
    let invoices = InvoiceManagerClient::new(&env, &invoice_id);
    invoices.initialize(&admin, &router_id, &registry_id);

    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token = sac.address();
    StellarAssetClient::new(&env, &token).mint(&payer, &100_000);

    World {
        env,
        invoices,
        router,
        token,
        payer,
        owner,
        admin,
        merchant_id,
        settlement,
        treasury,
    }
}

fn create_default(w: &World) -> u64 {
    w.invoices.create(
        &w.owner,
        &w.merchant_id,
        &w.token,
        &5_000,
        &2_000,
        &string(&w.env, "INV-1"),
    )
}

#[test]
fn create_and_pay_routes_funds() {
    let w = world();
    let id = create_default(&w);

    let invoice = w.invoices.get(&id);
    assert_eq!(invoice.status, InvoiceStatus::Open);
    assert_eq!(invoice.payment_id, None);
    assert_eq!(w.invoices.count(), 1);
    assert_eq!(w.invoices.open_count(), 1);

    let payment_id = w.invoices.pay(&w.payer, &id);
    let paid = w.invoices.get(&id);
    assert_eq!(paid.status, InvoiceStatus::Paid);
    assert_eq!(paid.payment_id, Some(payment_id));
    assert_eq!(paid.paid_at, Some(1_000));
    assert_eq!(w.invoices.open_count(), 0);

    // The invoice was settled by a real routed payment: 200 bps of 5_000.
    let payment = w.router.get_payment(&payment_id);
    assert_eq!(payment.fee, 100);
    assert_eq!(payment.net, 4_900);
    let token = TokenClient::new(&w.env, &w.token);
    assert_eq!(token.balance(&w.treasury), 100);
    assert_eq!(token.balance(&w.settlement), 4_900);
}

#[test]
fn only_merchant_owner_can_invoice() {
    let w = world();
    assert_eq!(
        w.invoices.try_create(
            &Address::generate(&w.env),
            &w.merchant_id,
            &w.token,
            &1_000,
            &2_000,
            &string(&w.env, "x"),
        ),
        Err(Ok(Error::Unauthorized))
    );
}

#[test]
fn due_date_must_be_in_the_future() {
    let w = world();
    assert_eq!(
        w.invoices.try_create(
            &w.owner,
            &w.merchant_id,
            &w.token,
            &1_000,
            &1_000,
            &string(&w.env, "x"),
        ),
        Err(Ok(Error::InvalidInput))
    );
}

#[test]
fn invoice_cannot_be_paid_twice() {
    let w = world();
    let id = create_default(&w);
    w.invoices.pay(&w.payer, &id);
    assert_eq!(
        w.invoices.try_pay(&w.payer, &id),
        Err(Ok(Error::InvalidState))
    );
}

#[test]
fn cancel_prevents_payment() {
    let w = world();
    let id = create_default(&w);
    w.invoices.cancel(&w.owner, &id);
    assert_eq!(w.invoices.get(&id).status, InvoiceStatus::Cancelled);
    assert_eq!(
        w.invoices.try_pay(&w.payer, &id),
        Err(Ok(Error::InvalidState))
    );
    assert_eq!(w.invoices.open_count(), 0);
}

#[test]
fn overdue_invoice_is_rejected_and_can_be_marked_expired() {
    let w = world();
    let id = create_default(&w);
    w.env.ledger().set_timestamp(2_001);

    assert_eq!(w.invoices.try_pay(&w.payer, &id), Err(Ok(Error::Expired)));
    w.invoices.mark_expired(&id);
    assert_eq!(w.invoices.get(&id).status, InvoiceStatus::Expired);

    // Expiry is not reversible and not repeatable.
    assert_eq!(
        w.invoices.try_mark_expired(&id),
        Err(Ok(Error::InvalidState))
    );
}

#[test]
fn cannot_expire_before_due_date() {
    let w = world();
    let id = create_default(&w);
    assert_eq!(
        w.invoices.try_mark_expired(&id),
        Err(Ok(Error::InvalidState))
    );
}

#[test]
fn unapproved_merchant_cannot_invoice() {
    let w = world();
    let registry = MerchantRegistryClient::new(&w.env, &w.invoices.registry());
    let owner = Address::generate(&w.env);
    let pending = registry.register(
        &owner,
        &Address::generate(&w.env),
        &string(&w.env, "Pending Co"),
        &100,
    );
    assert_eq!(
        w.invoices.try_create(
            &owner,
            &pending,
            &w.token,
            &1_000,
            &2_000,
            &string(&w.env, "x"),
        ),
        Err(Ok(Error::InvalidState))
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
        w.invoices
            .try_create(&w.owner, &w.merchant_id, &w.token, &1_000, &2_000, &long),
        Err(Ok(Error::InvalidInput))
    );
}

#[test]
fn pause_blocks_invoicing() {
    let w = world();
    w.invoices.grant_role(&w.admin, &Role::Admin, &w.admin);
    w.invoices.set_paused(&w.admin, &true);
    assert_eq!(
        w.invoices.try_create(
            &w.owner,
            &w.merchant_id,
            &w.token,
            &1_000,
            &2_000,
            &string(&w.env, "x"),
        ),
        Err(Ok(Error::Paused))
    );
}
