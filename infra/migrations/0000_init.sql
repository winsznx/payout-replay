CREATE TYPE "public"."capability_status" AS ENUM('verified', 'unverified', 'unavailable');--> statement-breakpoint
CREATE TYPE "public"."environment" AS ENUM('native', 'evm');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('owner', 'operator', 'reviewer', 'viewer');--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"secret_hash" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_keys_secret_hash_unique" UNIQUE("secret_hash")
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"manifest_version_id" text NOT NULL,
	"reviewer_id" text NOT NULL,
	"decision" text NOT NULL,
	"method" text NOT NULL,
	"digest" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" text PRIMARY KEY NOT NULL,
	"environment" "environment" NOT NULL,
	"chain_identity" text NOT NULL,
	"asset_id" text NOT NULL,
	"symbol" text NOT NULL,
	"decimals" integer NOT NULL,
	"allowlisted" boolean NOT NULL,
	"capability" "capability_status" NOT NULL,
	"code_hash" text,
	"label" text,
	"checked_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text,
	"actor_id" text,
	"actor_kind" text NOT NULL,
	"action" text NOT NULL,
	"object_type" text NOT NULL,
	"object_id" text NOT NULL,
	"before_digest" text,
	"after_digest" text,
	"detail" jsonb NOT NULL,
	"correlation_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_challenges" (
	"id" text PRIMARY KEY NOT NULL,
	"purpose" text NOT NULL,
	"environment" "environment" NOT NULL,
	"address" text NOT NULL,
	"org_id" text,
	"nonce" text NOT NULL,
	"message" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chain_observations" (
	"id" text PRIMARY KEY NOT NULL,
	"attempt_id" text NOT NULL,
	"provider" text NOT NULL,
	"outcome_kind" text NOT NULL,
	"block_hash" text,
	"block_number" text,
	"extrinsic_index" integer,
	"log_index" integer,
	"finalized" boolean NOT NULL,
	"raw" jsonb NOT NULL,
	"observed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exceptions" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"obligation_row_id" text,
	"fingerprint" text NOT NULL,
	"severity" text NOT NULL,
	"type" text NOT NULL,
	"message" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"resolution" text DEFAULT 'open' NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_records" (
	"key" text NOT NULL,
	"principal" text NOT NULL,
	"route" text NOT NULL,
	"request_hash" text NOT NULL,
	"status" integer NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "manifest_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"version" integer NOT NULL,
	"import_id" text NOT NULL,
	"canonical_json" text NOT NULL,
	"digest" text NOT NULL,
	"status" text NOT NULL,
	"duplicates_acknowledged" boolean NOT NULL,
	"frozen_by" text NOT NULL,
	"frozen_at" timestamp with time zone NOT NULL,
	"approved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "manual_resolutions" (
	"id" text PRIMARY KEY NOT NULL,
	"obligation_row_id" text NOT NULL,
	"reason" text NOT NULL,
	"proof_reference" text,
	"resolved_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "manual_resolutions_obligation_row_id_unique" UNIQUE("obligation_row_id")
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" "member_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "obligations" (
	"id" text PRIMARY KEY NOT NULL,
	"manifest_version_id" text NOT NULL,
	"run_id" text NOT NULL,
	"obligation_id" text NOT NULL,
	"line_id" text NOT NULL,
	"reference" text NOT NULL,
	"environment" "environment" NOT NULL,
	"asset_id" text NOT NULL,
	"payer" text NOT NULL,
	"destination" text NOT NULL,
	"amount_base_units" numeric(78, 0) NOT NULL,
	"status" text NOT NULL,
	"explanation" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organisations" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organisations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "payment_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"obligation_row_id" text NOT NULL,
	"obligation_id" text NOT NULL,
	"attempt_number" integer NOT NULL,
	"source" text NOT NULL,
	"plan_id" text,
	"environment" "environment" NOT NULL,
	"payer" text NOT NULL,
	"phase" text NOT NULL,
	"tx_hash" text,
	"nonce" bigint,
	"reported_block_hash" text,
	"mortality_birth" bigint,
	"mortality_period" integer,
	"idempotency_key" text NOT NULL,
	"outcome" jsonb NOT NULL,
	"outcome_kind" text NOT NULL,
	"created_by" text,
	"prepared_at" timestamp with time zone NOT NULL,
	"submitted_at" timestamp with time zone,
	"finalized_at" timestamp with time zone,
	"observed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "payout_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"status" text NOT NULL,
	"current_version" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"last_reconciled_at" timestamp with time zone,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recovery_plans" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"manifest_version_id" text NOT NULL,
	"manifest_digest" text NOT NULL,
	"kind" text NOT NULL,
	"plan" jsonb NOT NULL,
	"fingerprint" text NOT NULL,
	"status" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revalidated_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_imports" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"file_name" text,
	"file_sha256" text NOT NULL,
	"csv_text" text NOT NULL,
	"column_mapping" jsonb NOT NULL,
	"report" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"identity_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settlement_matches" (
	"id" text PRIMARY KEY NOT NULL,
	"obligation_row_id" text NOT NULL,
	"attempt_id" text NOT NULL,
	"tx_hash" text NOT NULL,
	"verified_amount_base_units" numeric(78, 0) NOT NULL,
	"category" text NOT NULL,
	"proof_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_identities" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"environment" "environment" NOT NULL,
	"address" text NOT NULL,
	"address_key" text NOT NULL,
	"verified_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"display_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"environment" "environment" NOT NULL,
	"address" text NOT NULL,
	"chain_identity" text NOT NULL,
	"verified_by" text NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"endpoint_id" text NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_status" integer,
	"last_error" text,
	"next_attempt_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_endpoints" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"url" text NOT NULL,
	"secret" text NOT NULL,
	"events" jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_manifest_version_id_manifest_versions_id_fk" FOREIGN KEY ("manifest_version_id") REFERENCES "public"."manifest_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chain_observations" ADD CONSTRAINT "chain_observations_attempt_id_payment_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."payment_attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exceptions" ADD CONSTRAINT "exceptions_run_id_payout_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."payout_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exceptions" ADD CONSTRAINT "exceptions_obligation_row_id_obligations_id_fk" FOREIGN KEY ("obligation_row_id") REFERENCES "public"."obligations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manifest_versions" ADD CONSTRAINT "manifest_versions_run_id_payout_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."payout_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manifest_versions" ADD CONSTRAINT "manifest_versions_import_id_run_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."run_imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manifest_versions" ADD CONSTRAINT "manifest_versions_frozen_by_users_id_fk" FOREIGN KEY ("frozen_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_resolutions" ADD CONSTRAINT "manual_resolutions_obligation_row_id_obligations_id_fk" FOREIGN KEY ("obligation_row_id") REFERENCES "public"."obligations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_resolutions" ADD CONSTRAINT "manual_resolutions_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obligations" ADD CONSTRAINT "obligations_manifest_version_id_manifest_versions_id_fk" FOREIGN KEY ("manifest_version_id") REFERENCES "public"."manifest_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obligations" ADD CONSTRAINT "obligations_run_id_payout_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."payout_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organisations" ADD CONSTRAINT "organisations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_run_id_payout_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."payout_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_obligation_row_id_obligations_id_fk" FOREIGN KEY ("obligation_row_id") REFERENCES "public"."obligations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_plan_id_recovery_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."recovery_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_runs" ADD CONSTRAINT "payout_runs_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_runs" ADD CONSTRAINT "payout_runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_plans" ADD CONSTRAINT "recovery_plans_run_id_payout_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."payout_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_plans" ADD CONSTRAINT "recovery_plans_manifest_version_id_manifest_versions_id_fk" FOREIGN KEY ("manifest_version_id") REFERENCES "public"."manifest_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_plans" ADD CONSTRAINT "recovery_plans_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_imports" ADD CONSTRAINT "run_imports_run_id_payout_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."payout_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_imports" ADD CONSTRAINT "run_imports_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_identity_id_user_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."user_identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_matches" ADD CONSTRAINT "settlement_matches_obligation_row_id_obligations_id_fk" FOREIGN KEY ("obligation_row_id") REFERENCES "public"."obligations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_matches" ADD CONSTRAINT "settlement_matches_attempt_id_payment_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."payment_attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_verified_by_users_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_id_webhook_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."webhook_endpoints"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "assets_chain_asset" ON "assets" USING btree ("chain_identity","asset_id");--> statement-breakpoint
CREATE INDEX "audit_events_org" ON "audit_events" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "chain_observations_attempt" ON "chain_observations" USING btree ("attempt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "exceptions_run_fingerprint" ON "exceptions" USING btree ("run_id","fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_principal_key" ON "idempotency_records" USING btree ("principal","key");--> statement-breakpoint
CREATE UNIQUE INDEX "manifest_versions_run_version" ON "manifest_versions" USING btree ("run_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_org_user" ON "memberships" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "obligations_version_line" ON "obligations" USING btree ("manifest_version_id","line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "obligations_version_obligation" ON "obligations" USING btree ("manifest_version_id","obligation_id");--> statement-breakpoint
CREATE INDEX "obligations_run" ON "obligations" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_attempts_idempotency" ON "payment_attempts" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_attempts_obligation_number" ON "payment_attempts" USING btree ("obligation_row_id","attempt_number");--> statement-breakpoint
CREATE INDEX "payment_attempts_run" ON "payment_attempts" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "payout_runs_org" ON "payout_runs" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "recovery_plans_run" ON "recovery_plans" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "settlement_matches_obligation_tx" ON "settlement_matches" USING btree ("obligation_row_id","tx_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "user_identities_env_key" ON "user_identities" USING btree ("environment","address_key");--> statement-breakpoint
CREATE UNIQUE INDEX "wallets_one_active_per_env" ON "wallets" USING btree ("org_id","environment") WHERE "wallets"."is_active";--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_endpoint_event" ON "webhook_deliveries" USING btree ("endpoint_id","event_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_due" ON "webhook_deliveries" USING btree ("next_attempt_at");