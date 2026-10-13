CREATE TABLE IF NOT EXISTS public.executor_deployment_signers (
  chain text PRIMARY KEY CHECK (chain IN ('ethereum','bnb')),
  chain_id integer NOT NULL CHECK (
    (chain = 'ethereum' AND chain_id = 1) OR
    (chain = 'bnb' AND chain_id = 56)
  ),
  signer_address text NOT NULL CHECK (signer_address ~ '^0x[0-9a-fA-F]{40}$'),
  vault_secret_id uuid NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.executor_deployment_signers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.executor_deployment_signers FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.executor_deployment_signers TO service_role;

DROP POLICY IF EXISTS executor_deployment_signers_service_role_read ON public.executor_deployment_signers;
CREATE POLICY executor_deployment_signers_service_role_read
  ON public.executor_deployment_signers
  FOR SELECT TO service_role
  USING (true);

CREATE OR REPLACE FUNCTION public.store_executor_deployment_signer(
  p_chain text,
  p_signer_address text,
  p_secret text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, vault
AS $$
DECLARE
  v_chain_id integer;
  v_secret_name text;
  v_secret_id uuid;
  v_existing public.executor_deployment_signers%ROWTYPE;
BEGIN
  IF coalesce(auth.jwt() ->> 'role', '') <> 'service_role' THEN
    RAISE EXCEPTION 'service_role_required' USING ERRCODE = '42501';
  END IF;
  IF p_chain NOT IN ('ethereum','bnb') THEN
    RAISE EXCEPTION 'deployment_signer_chain_not_allowlisted' USING ERRCODE = '22023';
  END IF;
  IF p_signer_address !~ '^0x[0-9a-fA-F]{40}$' THEN
    RAISE EXCEPTION 'deployment_signer_address_invalid' USING ERRCODE = '22023';
  END IF;
  IF coalesce(p_secret, '') !~ '^(0x)?[0-9A-Fa-f]{64}$' THEN
    RAISE EXCEPTION 'deployment_signer_secret_format_invalid' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('arbivault-executor-deployment-signer:' || p_chain, 0));

  SELECT * INTO v_existing
    FROM public.executor_deployment_signers
   WHERE chain = p_chain;

  IF FOUND THEN
    IF v_existing.status <> 'active' THEN
      RAISE EXCEPTION 'deployment_signer_retired' USING ERRCODE = '55000';
    END IF;
    RETURN jsonb_build_object(
      'ok', true,
      'created', false,
      'chain', v_existing.chain,
      'chain_id', v_existing.chain_id,
      'signer_address', v_existing.signer_address,
      'status', v_existing.status
    );
  END IF;

  v_chain_id := CASE p_chain WHEN 'ethereum' THEN 1 ELSE 56 END;
  v_secret_name := CASE p_chain
    WHEN 'ethereum' THEN 'arbivault-executor-deployment-signer-ethereum-v1'
    ELSE 'arbivault-executor-deployment-signer-bnb-v1'
  END;

  SELECT vault.create_secret(
    p_secret,
    v_secret_name,
    'Dedicated ArbiVault contract deployment signer for ' || p_chain || ' mainnet. Server-side only; never use for trading.'
  ) INTO v_secret_id;

  INSERT INTO public.executor_deployment_signers (
    chain, chain_id, signer_address, vault_secret_id, status
  ) VALUES (
    p_chain, v_chain_id, lower(p_signer_address), v_secret_id, 'active'
  )
  RETURNING * INTO v_existing;

  RETURN jsonb_build_object(
    'ok', true,
    'created', true,
    'chain', v_existing.chain,
    'chain_id', v_existing.chain_id,
    'signer_address', v_existing.signer_address,
    'status', v_existing.status
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_executor_deployment_signer_secret(p_chain text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, vault
AS $$
DECLARE
  v_secret_id uuid;
  v_secret text;
BEGIN
  IF coalesce(auth.jwt() ->> 'role', '') <> 'service_role' THEN
    RAISE EXCEPTION 'service_role_required' USING ERRCODE = '42501';
  END IF;
  IF p_chain NOT IN ('ethereum','bnb') THEN
    RAISE EXCEPTION 'deployment_signer_chain_not_allowlisted' USING ERRCODE = '22023';
  END IF;

  SELECT vault_secret_id
    INTO v_secret_id
    FROM public.executor_deployment_signers
   WHERE chain = p_chain
     AND status = 'active';

  IF v_secret_id IS NULL THEN
    RAISE EXCEPTION 'deployment_signer_not_provisioned' USING ERRCODE = 'P0002';
  END IF;

  SELECT ds.decrypted_secret
    INTO v_secret
    FROM vault.decrypted_secrets ds
   WHERE ds.id = v_secret_id
   LIMIT 1;

  IF v_secret IS NULL OR v_secret !~ '^(0x)?[0-9A-Fa-f]{64}$' THEN
    RAISE EXCEPTION 'deployment_signer_secret_unavailable';
  END IF;
  RETURN v_secret;
END;
$$;

REVOKE ALL ON FUNCTION public.store_executor_deployment_signer(text,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_executor_deployment_signer_secret(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.store_executor_deployment_signer(text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_executor_deployment_signer_secret(text) TO service_role;

CREATE OR REPLACE FUNCTION public.get_executor_deployment_secret()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, vault
AS $$
BEGIN
  RAISE EXCEPTION 'legacy_executor_deployment_key_retired' USING ERRCODE = '55000';
END;
$$;
REVOKE ALL ON FUNCTION public.get_executor_deployment_secret() FROM PUBLIC, anon, authenticated, service_role;
