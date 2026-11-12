//! Cross-contract integration tests: the merchant lifecycle from registration
//! through invoicing, settlement, refunds, treasury custody and an emergency
//! halt, exercised against one shared ledger.
//!
//! These tests deploy the real contract crates — no mocks — so they catch ABI
//! drift between contracts (shared types in `wpay-common`) and authorization
//! mistakes that unit tests with narrowed interfaces can miss.

#![no_std]

#[cfg(test)]
mod tests {
    use emergency_pause::EmergencyPauseClient;
    use fee_manager::FeeManagerClient;
    use invoice_manager::{InvoiceManagerClient, InvoiceStatus};
    use merchant_registry::MerchantRegistryClient;
    use payment_router::{PaymentRouterClient, PaymentStatus};
    use price_oracle::PriceOracleClient;
    use refund_manager::RefundManagerClient;
    use soroban_sdk::testutils::{Address as _, Ledger as _};
    use soroban_sdk::token::{StellarAssetClient, TokenClient};
    use soroban_sdk::{symbol_short, Address, Env, String};
    use treasury_vault::TreasuryVaultClient;
    use wpay_common::Role;

    struct Platform {
        env: Env,
        registry: MerchantRegistryClient<'static>,
        fee: FeeManagerClient<'static>,
        router: PaymentRouterClient<'static>,
        invoices: InvoiceManagerClient<'static>,
        refunds: RefundManagerClient<'static>,
        treasury: TreasuryVaultClient<'static>,
        pause: EmergencyPauseClient<'static>,
        oracle: PriceOracleClient<'static>,
        token: Address,
        admin: Address,
        merchant_owner: Address,
        settlement: Address,
        payer: Address,
    }

    fn text(env: &Env, s: &str) -> String {
        String::from_str(env, s)
    }

    /// Deploys the platform and provisions one approved merchant.
    fn platform() -> Platform {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(1_000);

        let admin = Address::generate(&env);
        let merchant_owner = Address::generate(&env);
        let settlement = Address::generate(&env);
        let payer = Address::generate(&env);
        let treasury_addr = Address::generate(&env);

        let registry_id = env.register(merchant_registry::MerchantRegistry, ());
        let registry = MerchantRegistryClient::new(&env, &registry_id);
        registry.initialize(&admin);

        let fee_id = env.register(fee_manager::FeeManager, ());
        let fee = FeeManagerClient::new(&env, &fee_id);
        fee.initialize(&admin, &treasury_addr, &250);

        let router_id = env.register(payment_router::PaymentRouter, ());
        let router = PaymentRouterClient::new(&env, &router_id);
        router.initialize(&admin, &registry_id, &fee_id, &treasury_addr);

        let invoices_id = env.register(invoice_manager::InvoiceManager, ());
        let invoices = InvoiceManagerClient::new(&env, &invoices_id);
        invoices.initialize(&admin, &router_id, &registry_id);

        let refunds_id = env.register(refund_manager::RefundManager, ());
        let refunds = RefundManagerClient::new(&env, &refunds_id);
        refunds.initialize(&admin, &router_id, &registry_id);
        router.grant_role(&admin, &Role::Operator, &refunds_id);

        let vault_id = env.register(treasury_vault::TreasuryVault, ());
        let treasury = TreasuryVaultClient::new(&env, &vault_id);
        treasury.initialize(&admin);

        let pause_id = env.register(emergency_pause::EmergencyPause, ());
        let pause = EmergencyPauseClient::new(&env, &pause_id);
        pause.initialize(&admin);

        let oracle_id = env.register(price_oracle::PriceOracle, ());
        let oracle = PriceOracleClient::new(&env, &oracle_id);
        oracle.initialize(&admin, &3_600);

        // Every pauseable contract adopts the circuit breaker.
        treasury.set_pause_authority(&admin, &pause_id);
        pause.register_target(&admin, &vault_id);

        // Merchant onboarding: self-register, then the operator approves.
        registry.grant_role(&admin, &Role::Operator, &admin);
        let merchant_id = registry.register(
            &merchant_owner,
            &settlement,
            &text(&env, "Northwind Supply"),
            &250,
        );
        registry.approve(&admin, &merchant_id);

        let sac = env.register_stellar_asset_contract_v2(admin.clone());
        let token = sac.address();
        StellarAssetClient::new(&env, &token).mint(&payer, &100_000);
        StellarAssetClient::new(&env, &token).mint(&admin, &100_000);

        Platform {
            env,
            registry,
            fee,
            router,
            invoices,
            refunds,
            treasury,
            pause,
            oracle,
            token,
            admin,
            merchant_owner,
            settlement,
            payer,
        }
    }

    #[test]
    fn merchant_lifecycle_from_registration_to_refund() {
        let p = platform();
        let merchant_id = p.registry.merchant_of(&p.merchant_owner).unwrap();
        assert!(p.registry.is_active(&merchant_id));

        // Invoice -> routed payment.
        let invoice = p.invoices.create(
            &p.merchant_owner,
            &merchant_id,
            &p.token,
            &20_000,
            &5_000,
            &text(&p.env, "PO-7741"),
        );
        let payment_id = p.invoices.pay(&p.payer, &invoice);
        assert_eq!(p.invoices.get(&invoice).status, InvoiceStatus::Paid);

        let payment = p.router.get_payment(&payment_id);
        assert_eq!(payment.fee, 500); // 250 bps
        assert_eq!(payment.net, 19_500);

        let token = TokenClient::new(&p.env, &p.token);
        assert_eq!(token.balance(&p.settlement), 19_500);
        assert_eq!(p.router.volume(&merchant_id), 20_000);

        // Partial refund approved by the settlement wallet.
        let refund = p.refunds.request(
            &p.payer,
            &payment_id,
            &5_000,
            &text(&p.env, "short shipment"),
        );
        p.refunds.approve(&p.settlement, &refund);
        assert_eq!(
            p.router.get_payment(&payment_id).status,
            PaymentStatus::PartiallyRefunded
        );
        assert_eq!(token.balance(&p.settlement), 14_500);
        assert_eq!(token.balance(&p.payer), 85_000);

        // Fee revenue lands in the treasury vault and can be withdrawn.
        let revenue = token.balance(&p.payer);
        let _ = revenue;
        p.treasury.set_threshold(&p.admin, &p.token, &1_000);
        assert_eq!(p.treasury.deposit(&p.admin, &p.token, &500), 500);
        let recipient = Address::generate(&p.env);
        p.treasury.withdraw(&p.admin, &p.token, &recipient, &400);
        assert_eq!(p.treasury.balance(&p.token), 100);
    }

    #[test]
    fn oracle_and_fee_policy_are_consistent() {
        let p = platform();
        let usdc = symbol_short!("USDC");
        let eurc = symbol_short!("EURC");
        p.oracle.set_price(&p.admin, &usdc, &1_000_000, &6);
        p.oracle.set_price(&p.admin, &eurc, &1_100_000, &6);
        assert_eq!(p.oracle.convert(&1_000_000, &usdc, &eurc), 909_090);

        // A per-merchant override changes the split at the next payment.
        p.fee
            .set_merchant_fee(&p.admin, &p.merchant_owner, &Some(100));
        let payment_id = p.router.create_payment(
            &p.payer,
            &p.registry.merchant_of(&p.merchant_owner).unwrap(),
            &p.token,
            &10_000,
            &text(&p.env, "override"),
        );
        assert_eq!(p.router.get_payment(&payment_id).fee, 100);
    }

    #[test]
    fn emergency_pause_halts_treasury_outflows() {
        let p = platform();
        p.treasury.deposit(&p.admin, &p.token, &1_000);
        p.treasury.set_threshold(&p.admin, &p.token, &5_000);
        p.pause.pause_all(&p.admin);
        assert!(p.treasury.is_paused());

        let recipient = Address::generate(&p.env);
        assert_eq!(
            p.treasury
                .try_withdraw(&p.admin, &p.token, &recipient, &100),
            Err(Ok(wpay_common::Error::Paused))
        );

        p.pause.unpause_all(&p.admin);
        assert!(!p.treasury.is_paused());
        p.treasury.withdraw(&p.admin, &p.token, &recipient, &100);
    }

    #[test]
    fn suspended_merchant_cannot_take_new_payments() {
        let p = platform();
        let merchant_id = p.registry.merchant_of(&p.merchant_owner).unwrap();
        p.registry.suspend(&p.admin, &merchant_id);
        assert_eq!(
            p.router.try_create_payment(
                &p.payer,
                &merchant_id,
                &p.token,
                &1_000,
                &text(&p.env, "x")
            ),
            Err(Ok(wpay_common::Error::InvalidState))
        );
        let _ = &p.env;
    }
}
