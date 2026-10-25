-- Deferred checks inspect final transaction state; legacy unlinked rows are untouched.
CREATE FUNCTION assert_customer_repayment_cash_pair(payment_id uuid, was_linked boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE payment customer_ledger; movement shift_movements; cash_shift shifts; movement_count integer;
BEGIN
 SELECT * INTO payment FROM customer_ledger WHERE id=payment_id FOR UPDATE;
 IF NOT FOUND THEN RETURN; END IF; -- Deleted pairs remain subject to their normal foreign keys.
 SELECT count(*) INTO movement_count FROM shift_movements WHERE customer_payment_ledger_id=payment.id;
 IF payment.shift_id IS NULL AND payment.register_id IS NULL THEN
  IF was_linked OR movement_count<>0 THEN
   RAISE EXCEPTION 'Customer repayment cash provenance cannot be removed' USING ERRCODE='23514';
  END IF;
  RETURN;
 END IF;
 IF payment.entry_type<>'PAYMENT' OR payment.payment_method IS DISTINCT FROM 'cash'
   OR payment.amount>=0 OR payment.shift_id IS NULL OR payment.register_id IS NULL
   OR payment.store_id IS NULL OR movement_count<>1 THEN
  RAISE EXCEPTION 'Customer cash repayment requires exactly one cash movement' USING ERRCODE='23514';
 END IF;
 SELECT * INTO movement FROM shift_movements WHERE customer_payment_ledger_id=payment.id;
 SELECT * INTO cash_shift FROM shifts WHERE id=payment.shift_id;
 IF NOT FOUND OR cash_shift.organization_id<>payment.organization_id
   OR cash_shift.store_id<>payment.store_id OR cash_shift.register_id IS DISTINCT FROM payment.register_id
   OR movement.organization_id<>payment.organization_id OR movement.shift_id<>payment.shift_id
   OR movement.type<>'in' OR movement.source<>'customer_payment'
   OR movement.reference_id<>payment.id::text OR movement.amount<>-payment.amount THEN
  RAISE EXCEPTION 'Customer repayment cash movement does not match its ledger provenance' USING ERRCODE='23514';
 END IF;
END $$;

CREATE FUNCTION check_customer_repayment_cash_pair() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='customer_ledger' THEN
  IF TG_OP<>'INSERT' AND (OLD.shift_id IS NOT NULL OR OLD.register_id IS NOT NULL) THEN
   PERFORM assert_customer_repayment_cash_pair(OLD.id,true);
  END IF;
  IF TG_OP<>'DELETE' AND (NEW.shift_id IS NOT NULL OR NEW.register_id IS NOT NULL) THEN
   PERFORM assert_customer_repayment_cash_pair(NEW.id);
  END IF;
 ELSE
  IF TG_OP<>'INSERT' AND OLD.customer_payment_ledger_id IS NOT NULL THEN
   PERFORM assert_customer_repayment_cash_pair(OLD.customer_payment_ledger_id);
  END IF;
  IF TG_OP<>'DELETE' AND NEW.customer_payment_ledger_id IS NOT NULL THEN
   PERFORM assert_customer_repayment_cash_pair(NEW.customer_payment_ledger_id);
  END IF;
 END IF;
 RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER customer_repayment_cash_pair_guard
 AFTER INSERT OR UPDATE OR DELETE ON customer_ledger DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION check_customer_repayment_cash_pair();
CREATE CONSTRAINT TRIGGER customer_repayment_movement_pair_guard
 AFTER INSERT OR UPDATE OR DELETE ON shift_movements DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION check_customer_repayment_cash_pair();
