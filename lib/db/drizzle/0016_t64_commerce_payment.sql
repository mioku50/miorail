-- T64.3: the commerce payment rail. Additive only.
--
-- A gift card is paid with ONE exact ERC-20 transfer to the address the invoice
-- named, so it gets its own Blueprint table rather than reusing
-- execution_blueprints — that table is swap/earn-shaped and carries a `goal`
-- check plus approval semantics that do not describe this rail.
--
-- Nothing here holds redemption material. Delivery is recorded as a state, a
-- timestamp and a hash over a REDACTED provider response.

CREATE TABLE "commerce_payment_blueprints" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"user_id" text NOT NULL,
	"wallet_address" text NOT NULL,
	"schema_version" text NOT NULL,
	"status" text NOT NULL,
	"blueprint_hash" text NOT NULL,
	"calls_hash" text NOT NULL,
	"approved_calls_hash" text,
	"invoice_id" text NOT NULL,
	"exact_amount_atomic" text NOT NULL,
	"recipient" text NOT NULL,
	"recipient_policy" text NOT NULL,
	"payload" jsonb NOT NULL,
	"submission_batch_id" text,
	"transaction_hash" text,
	"onchain_state" text,
	"provider_progress" text,
	"delivery_record" jsonb,
	"invoice_expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_payment_blueprints_order_id_commerce_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."commerce_orders"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "commerce_payment_blueprints_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "commerce_payment_blueprints_status_check" CHECK ("commerce_payment_blueprints"."status" IN ('ready_for_review', 'approved', 'submitted', 'confirmed_onchain', 'provider_confirmed', 'delivered', 'failed', 'reconciliation_required')),
	CONSTRAINT "commerce_payment_blueprints_recipient_policy_check" CHECK ("commerce_payment_blueprints"."recipient_policy" IN ('pinned', 'invoice_scoped'))
);
--> statement-breakpoint
-- One payment Blueprint per order: a second wallet prompt for the same order
-- is a duplicate payment risk, so the database refuses it.
CREATE UNIQUE INDEX "commerce_payment_blueprints_order_unique" ON "commerce_payment_blueprints" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_payment_blueprints_user_hash_unique" ON "commerce_payment_blueprints" USING btree ("user_id", "blueprint_hash");--> statement-breakpoint
CREATE INDEX "commerce_payment_blueprints_user_status_idx" ON "commerce_payment_blueprints" USING btree ("user_id", "status");
