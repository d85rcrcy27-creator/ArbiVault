alter table public.arbivault_signing_auth_challenges
  drop constraint if exists arbivault_signing_auth_challenges_challenge_type_check;

alter table public.arbivault_signing_auth_challenges
  add constraint arbivault_signing_auth_challenges_challenge_type_check
  check (challenge_type = any (array[
    'registration'::text,
    'assertion'::text,
    'pin_setup'::text,
    'pin_assertion'::text,
    'transaction_approval'::text
  ]));

alter table public.arbivault_signing_auth_challenges
  add column if not exists payload_hash text;
