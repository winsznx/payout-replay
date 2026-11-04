-- INV-01: a frozen manifest version never changes. Only its approval status may move.
CREATE OR REPLACE FUNCTION forbid_manifest_mutation() RETURNS trigger AS $$
BEGIN
  IF NEW.canonical_json IS DISTINCT FROM OLD.canonical_json
     OR NEW.digest IS DISTINCT FROM OLD.digest
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.run_id IS DISTINCT FROM OLD.run_id
     OR NEW.import_id IS DISTINCT FROM OLD.import_id THEN
    RAISE EXCEPTION 'manifest version % is frozen; create a new version instead', OLD.id;
  END IF;
  IF OLD.status IN ('approved', 'rejected', 'superseded') AND NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'approved' AND NEW.status = 'superseded') THEN
    RAISE EXCEPTION 'manifest version % already %', OLD.id, OLD.status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER manifest_versions_immutable BEFORE UPDATE ON manifest_versions
  FOR EACH ROW EXECUTE FUNCTION forbid_manifest_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forbid_frozen_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER manifest_versions_no_delete BEFORE DELETE ON manifest_versions
  FOR EACH ROW EXECUTE FUNCTION forbid_frozen_delete();
--> statement-breakpoint
-- Obligation terms are frozen with the manifest; only the derived status may change.
CREATE OR REPLACE FUNCTION forbid_obligation_mutation() RETURNS trigger AS $$
BEGIN
  IF NEW.obligation_id IS DISTINCT FROM OLD.obligation_id
     OR NEW.line_id IS DISTINCT FROM OLD.line_id
     OR NEW.environment IS DISTINCT FROM OLD.environment
     OR NEW.asset_id IS DISTINCT FROM OLD.asset_id
     OR NEW.payer IS DISTINCT FROM OLD.payer
     OR NEW.destination IS DISTINCT FROM OLD.destination
     OR NEW.amount_base_units IS DISTINCT FROM OLD.amount_base_units
     OR NEW.reference IS DISTINCT FROM OLD.reference
     OR NEW.manifest_version_id IS DISTINCT FROM OLD.manifest_version_id THEN
    RAISE EXCEPTION 'obligation % terms are frozen', OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER obligations_immutable BEFORE UPDATE ON obligations
  FOR EACH ROW EXECUTE FUNCTION forbid_obligation_mutation();
--> statement-breakpoint
CREATE TRIGGER obligations_no_delete BEFORE DELETE ON obligations
  FOR EACH ROW EXECUTE FUNCTION forbid_frozen_delete();
--> statement-breakpoint
-- A signed transaction never changes its obligation or identity once recorded.
CREATE OR REPLACE FUNCTION forbid_attempt_identity_change() RETURNS trigger AS $$
BEGIN
  IF NEW.obligation_row_id IS DISTINCT FROM OLD.obligation_row_id
     OR NEW.obligation_id IS DISTINCT FROM OLD.obligation_id
     OR NEW.attempt_number IS DISTINCT FROM OLD.attempt_number
     OR NEW.payer IS DISTINCT FROM OLD.payer
     OR NEW.environment IS DISTINCT FROM OLD.environment
     OR (OLD.tx_hash IS NOT NULL AND NEW.tx_hash IS DISTINCT FROM OLD.tx_hash)
     OR (OLD.nonce IS NOT NULL AND NEW.nonce IS DISTINCT FROM OLD.nonce) THEN
    RAISE EXCEPTION 'attempt % identity is write-once', OLD.id;
  END IF;
  IF OLD.phase IN ('submitted', 'submission_unknown', 'signature_rejected') AND NEW.phase IS DISTINCT FROM OLD.phase THEN
    RAISE EXCEPTION 'attempt % phase % is final', OLD.id, OLD.phase;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER payment_attempts_identity BEFORE UPDATE ON payment_attempts
  FOR EACH ROW EXECUTE FUNCTION forbid_attempt_identity_change();
--> statement-breakpoint
CREATE TRIGGER payment_attempts_no_delete BEFORE DELETE ON payment_attempts
  FOR EACH ROW EXECUTE FUNCTION forbid_frozen_delete();
--> statement-breakpoint
CREATE TRIGGER chain_observations_no_delete BEFORE DELETE ON chain_observations
  FOR EACH ROW EXECUTE FUNCTION forbid_frozen_delete();
--> statement-breakpoint
CREATE TRIGGER audit_events_no_update BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION forbid_frozen_delete();
