-- Keep research and execution strategies distinct and deterministic.
update public.bot_skills
set name='Flash Loan — Research',
    actions=jsonb_build_array(
      jsonb_build_object('type','action','label','THEN Send Alert')
    )
where id='aab008e5-b872-4087-94f7-d5ae75583b6b';

update public.bot_skills
set name='Flash Loan — Execution',
    conditions=jsonb_build_array(
      jsonb_build_object('type','condition','unit','%','label','IF Spread >','value','0.25'),
      jsonb_build_object('type','condition','unit','USD','label','IF Profit >','value','5.00')
    )
where id='fc8d2643-fee6-4265-858c-9899d81df64f';

update public.bot_skills
set name='Snipe — Research',
    actions=jsonb_build_array(
      jsonb_build_object('type','action','label','THEN Send Alert')
    )
where id='45d1e0de-2cfd-4d67-bf0a-b1744467b2a5';

update public.bot_skills
set name='Snipe — Execution'
where id='fb59281d-eb71-4d75-8f0e-7746117f985d';

-- The profitable Flash Loan research bot is observation-only.
update public.arbivault_strategy_bots
set execution_enabled=false
where id='a33d5f62-a8e5-4196-b6a4-f01d8b590acd'
  and strategy='flash_loan_arbitrage'
  and not exists (
    select 1
    from public.arbivault_strategy_routes
    where strategy_bot_id='a33d5f62-a8e5-4196-b6a4-f01d8b590acd'
      and enabled=true
  );

-- The executable Flash Loan bot owns the strategy execution wallets.
update public.arbivault_strategy_wallets
set strategy_bot_id='440fe8c9-f23d-4711-85d1-5b2b7edc75a3',
    updated_at=now()
where strategy_bot_id='a33d5f62-a8e5-4196-b6a4-f01d8b590acd';

-- Remove the orphan duplicate Flash Loan execution bot/skill when unreferenced.
delete from public.bot_skills
where id='1ae0d5fc-4e67-41f9-909b-0d716d0888da'
  and strategy_bot_id='8315c65a-d73b-4145-b2a2-7ab2f32e2229'
  and not exists (select 1 from public.strategy_observations where bot_skill_id=public.bot_skills.id)
  and not exists (select 1 from public.trades where bot_skill_id=public.bot_skills.id);

delete from public.arbivault_strategy_bots
where id='8315c65a-d73b-4145-b2a2-7ab2f32e2229'
  and not exists (select 1 from public.bot_skills where strategy_bot_id=public.arbivault_strategy_bots.id)
  and not exists (select 1 from public.arbivault_strategy_routes where strategy_bot_id=public.arbivault_strategy_bots.id)
  and not exists (select 1 from public.arbivault_strategy_wallets where strategy_bot_id=public.arbivault_strategy_bots.id)
  and not exists (select 1 from public.execution_attempts where strategy_bot_id=public.arbivault_strategy_bots.id);
