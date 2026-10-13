CREATE TABLE IF NOT EXISTS public.flash_executor_deployments (
  chain text PRIMARY KEY CHECK (chain IN ('ethereum','bnb')),
  chain_id integer NOT NULL CHECK (
    (chain = 'ethereum' AND chain_id = 1) OR
    (chain = 'bnb' AND chain_id = 56)
  ),
  contract_name text NOT NULL,
  executor_address text,
  deployment_tx_hash text,
  deployer_address text,
  deployment_nonce bigint,
  hot_wallet_id uuid NOT NULL REFERENCES public.wallets(id),
  hot_wallet_address text NOT NULL CHECK (hot_wallet_address ~ '^0x[0-9a-fA-F]{40}$'),
  pool_address text NOT NULL CHECK (pool_address ~ '^0x[0-9a-fA-F]{40}$'),
  contract_source_blob_sha text NOT NULL CHECK (contract_source_blob_sha ~ '^[0-9a-f]{40}$'),
  init_code_hash text,
  runtime_bytecode_hash text,
  status text NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending','deployed_unverified','verified','failed')
  ),
  source_verified boolean NOT NULL DEFAULT false,
  payout_audited boolean NOT NULL DEFAULT false,
  payout_behavior_verified boolean NOT NULL DEFAULT false,
  failure_code text,
  github_workflow_ref text,
  github_run_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT flash_executor_payout_audit_requires_source
    CHECK (NOT payout_audited OR source_verified),
  CONSTRAINT flash_executor_behavior_requires_audit
    CHECK (NOT payout_behavior_verified OR payout_audited)
);

ALTER TABLE public.flash_executor_deployments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.flash_executor_deployments FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.flash_executor_deployments TO service_role;

CREATE OR REPLACE FUNCTION public.get_executor_deployment_secret()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, vault
AS $$
DECLARE
  v_secret text;
BEGIN
  IF coalesce(auth.jwt() ->> 'role', '') <> 'service_role' THEN
    RAISE EXCEPTION 'service_role_required' USING ERRCODE = '42501';
  END IF;

  SELECT ds.decrypted_secret
    INTO v_secret
    FROM vault.decrypted_secrets ds
    JOIN vault.secrets s ON s.id = ds.id
   WHERE s.name = 'Etherum/BSC contract deployment '
   ORDER BY s.created_at DESC
   LIMIT 1;

  IF v_secret IS NULL OR length(v_secret) NOT IN (64,66) THEN
    RAISE EXCEPTION 'executor_deployment_secret_unavailable';
  END IF;
  IF v_secret !~ '^(0x)?[0-9A-Fa-f]{64}$' THEN
    RAISE EXCEPTION 'executor_deployment_secret_format_invalid';
  END IF;

  RETURN v_secret;
END;
$$;

REVOKE ALL ON FUNCTION public.get_executor_deployment_secret() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_executor_deployment_secret() TO service_role;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public'
      AND tablename='flash_executor_deployments'
      AND policyname='flash_executor_deployments_service_role_only'
  ) THEN
    CREATE POLICY flash_executor_deployments_service_role_only
      ON public.flash_executor_deployments
      FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END
$$;
