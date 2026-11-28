# Campaign Studio · FINAL 05E
## Roteiro de homologação externa

**Base** · `julianoborba07-cmd/stripe-checkout`, branch `campaign-studio-release-mapped-reservation`, checkpoint `e0f4041117bb4292baa00119ee757ad915d84040`. Este roteiro acompanha o patch FINAL 05C + 05D. Os caminhos de código e SQL são relativos a um checkout com o patch aplicado. O ZIP também contém os mesmos arquivos alterados sob `arquivos/`.

Os gates comerciais são fechados por padrão. A recuperação automática por SMS permanece desativada. Nesta etapa foram produzidos e verificados os artefatos locais. As ações em serviços externos abaixo pertencem a uma futura janela autorizada.

## A · Supabase PREVIEW

A ordem abaixo considera as 19 funções legadas já instaladas. Registre o identificador do PREVIEW, a versão dos arquivos e as saídas sem dados de clientes.

| Ordem e tipo | Arquivo ou comando | Ação e critério de aprovação |
| --- | --- | --- |
| A1 · Preflight somente leitura | `qa/campaign-studio/preview/01_PREFLIGHT_PREVIEW.sql` | Conferir projeto, 19/19 RPCs de baseline, 1/1 de autoria, argumentos, grants, tabelas e colunas. Exigir ausência de bloqueios. Registrar contagens agregadas das filas antes da mudança. |
| A2 · Verificação do baseline somente leitura | `migrations/campaign-studio/verify/05c-00-mapped-baseline.sql` | Exigir `VERIFIED`, exclusão ativa para holds e snapshots imutáveis. Preservar as funções presentes. `05c-00-mapped-baseline.sql` fica reservado a uma instalação limpa e `qa/campaign-studio/05a-commercial-install-preview.sql` ao registro histórico. |
| A3 · Migração candidata 01, se ausente | `migrations/campaign-studio/05c-01-commercial-authorization.sql` | Antes de instalar, exigir `mapped_flags_enabled=0`, pré-requisitos e janela sem tráfego comercial. Registra autorização e auditoria vinculadas à versão e revisão, além das guardas de captura. |
| A4 · Migração candidata 02, se ausente | `migrations/campaign-studio/05c-02-commercial-ghl-effects.sql` | Exigir 01 verificada e RPC legado de checkpoint compatível. Instalar apenas o wrapper comercial de efeitos. |
| A5 · Migração candidata 03, se ausente | `migrations/campaign-studio/05c-03-commercial-metrics.sql` | Exigir 01 e 02 verificadas. Instalar verificação de dependências e agregação de métricas. |
| A6 · Permissões e catálogo somente leitura | Repetir A1 e A2, depois `qa/campaign-studio/preview/03_VERIFICAR_FUNCOES_PREVIEW.sql` | Exigir `candidate_catalog=VERIFIED`, 16 funções candidatas, 2 ledgers com RLS e 4 triggers ativos. Conferir proprietários, hashes dos corpos e grants nos papéis `anon`, `authenticated` e `service_role`. Em sessão de leitura sob `service_role`, `SELECT public.lltouch_cm_commercial_dependencies_v1();` deve retornar `{"missing":[]}`. O RPC de prontidão também detecta incompatibilidades de assinatura que o inventário de argumentos pode aceitar. |
| A7 · Testes transacionais, local ou clone isolado autorizado | `bash qa/campaign-studio/preview/testar-sql-local.sh` | O harness usa socket Unix e `--network none`. Exercita `05c-authorization.test.sql`, `05c-ghl-effects.test.sql` e `mapped-lifecycle.integration.sql` em bases descartáveis. Preservar os `ROLLBACK`. Exigir aprovação dos cenários de captura, pagamentos, métricas e revogação. |
| A8 · Testes de concorrência, local ou clone isolado autorizado | Mesmo harness, que chama `qa/campaign-studio/05c-authorization-concurrency.integration.mjs` e `qa/campaign-studio/05d-booking-concurrency.integration.mjs` | Exigir espera observada em sessões distintas, rejeição da revisão obsoleta, bloqueio de sobreposição, liberação após rollback e limpeza de fixtures. O teste do escritor legado usa uma implementação sintética do lock compartilhado. |
| A9 · Verificação final somente leitura | `qa/campaign-studio/preview/06_VERIFICACAO_FINAL_PREVIEW.sql` | Exigir `db_consistency=VERIFIED`. Comparar contagens de checkout, booking e CRM com o inventário inicial. Documentar e tratar pendências antes de liberar. |

Execute cada migração candidata como uma transação própria, com `psql -X -v ON_ERROR_STOP=1 -f <arquivo>` ou pelo SQL Editor de um projeto previamente verificado. Em `PRESENT_VERIFY`, compare corpo, versão, proprietário e privilégios com a referência antes de pular aquela migração. Um conjunto parcial, divergente ou fora de ordem precisa de investigação antes de qualquer alteração. O verificador A6 pressupõe as três candidatas instaladas. Use o catálogo e a referência local de cada migração para comparar uma candidata já presente antes de aplicar a seguinte.

O harness local confirma isolamento e contratos com fixtures. Seu inventário deliberadamente contém 12/19 RPCs de baseline e 0/1 de autoria. Exija 19/19 e 1/1 no alvo real. Homologue também as implementações legadas reais em clone descartável autorizado, com dados sintéticos e sem conectividade externa. Depois de A5, uma chamada em leitura de `lltouch_cm_commercial_metrics_v1` com o UUID sintético `00000000-0000-0000-0000-000000000000` sob `service_role` pode conferir acesso aos ledgers sem retornar linhas de contato.

**Evidência de aceite** · Registros de A1/A2/A6/A9, SHA-256 das migrações, saída dos testes e diferença explicada das filas. **Execução** · Inventário, verificação e testes locais são automatizáveis. Conferência do alvo, clone autorizado e alterações de schema exigem responsável pelo ambiente.

### Rollback PREVIEW

1. Fechar novas reservas, checkout e efeitos comerciais no CRM. Revogar ou pausar a versão atingida pelo painel. Conservar webhook e liquidação para operações já aceitas e conciliar os estados em voo.
2. Preservar snapshots, registros e auditoria se já houve uso. A reversão operacional mantém o schema e os ledgers.
3. Aplicar rollback DDL somente sob manutenção, com `authorizations=0`, `audit_events=0` e nenhum trabalho em voo, conferidos **antes do primeiro passo DDL**. Os arquivos têm transações separadas.
4. Usar a sequência exata `migrations/campaign-studio/rollback/05c-03-commercial-metrics.sql` → `migrations/campaign-studio/rollback/05c-02-commercial-ghl-effects.sql` → `migrations/campaign-studio/rollback/05c-01-commercial-authorization.sql`. Repetir A1 e A2 e confirmar o baseline preservado. O rollback de 00 cabe somente para uma instalação separada, nova e vazia feita pelo próprio 00.

## B · Segurança do GoHighLevel

- **Ação** · Conferir a localização e os escopos da credencial, deduplicação por telefone e e-mail e todos os workflows acionados por criação, atualização ou inclusão das tags. Validar o conector com contatos sintéticos, inclusive um contato com DND e opt-out, conforme `qa/campaign-studio/05d-ghl-homologation.md`.
- **Resultado esperado** · Upsert do contato novo, atualização dos campos ausentes pelo ID, leitura confirmando identidade e tags. Consentimentos ficam vinculados ao lead. DND, opt-out e configuração de marketing permanecem preservados.
- **Evidência exigida** · Registro dos escopos sem segredos, respostas redigidas, política de deduplicação, checkpoints e histórico de execuções com zero inscrições ou mensagens indevidas. Confirmar em leitura o estado de rascunho do workflow de recuperação.
- **Aprovação** · Vínculo ao mesmo contato após repetição, tags corretas, falhas ambíguas conciliáveis e ausência de efeitos de mensagem. Os casos sintéticos e diffs são automatizáveis. O operador GHL autorizado comprova permissões, omissões em PUT, prioridades, workflows e efeitos concorrentes.

## C · Stripe em modo de teste

- **Ação** · Confirmar sandbox segregada, chave `sk_test_`, segredo do webhook daquele sandbox e destinos de retorno autorizados. Usar apenas as rotas QA autenticadas previstas para aquele cenário, como `stripe-test-create`, `stripe-qa-create` ou `funnel-qa-create`, com sua respectiva prontidão e ledger. Usar contas, cartões e dados de teste. Confirmar que nenhum destino da experiência aponta para produção.
- **Resultado esperado** · Sessões QA em `cs_test_` e `livemode=false`, valor USD 25 no cenário HydraFacial, metadados vinculados a campanha, versão e nonce, assinatura válida, idempotência, expiração e eventos repetidos ou fora de ordem tratados.
- **Evidência exigida** · IDs de teste redigidos, valor, metadata esperada, logs de assinatura aceita e rejeitada, eventos de abertura, pagamento, expiração e conciliação. Registrar precisamente quais rotas e ledgers foram usados. Preserve a evidência do percurso mapeado testado por mocks e eventos sintéticos assinados.
- **Aprovação** · Separar o aceite do conector em sandbox do aceite completo do checkout mapeado. A candidata mapeada exige chave/modo live e `cs_live_` no código, no SQL e no asset de reserva. Os assets públicos têm origem Render e URLs de retorno de produção. A homologação completa do mapeado com a Stripe real em modo de teste depende de um caminho isolado, explicitamente autorizado, com chave, ledger e origens de retorno de teste. Manter esse item pendente até haver tal caminho, sem liberar flags live. Verificação automática cabe a fixtures e testes assinados. Sandbox e aprovação do isolamento exigem operador autorizado.

## D · Motor existente Vagaro e Google Calendar

- **Ação** · Executar o protocolo de leitura de um único agendamento histórico descrito abaixo, nos registros e calendários já existentes.
- **Resultado esperado** · Rastrear a cadeia do funil ao ledger Supabase, ao evento Google e à entidade observada no Vagaro. Registrar separadamente os estados de bloqueio, Personal Task e eventual appointment nativo.
- **Evidência exigida** · IDs redigidos, origem autenticada, estabelecimento, tipo da entidade, estado, profissional, serviço, intervalo e correlação do booking com o evento Google e a entidade Vagaro.
- **Aprovação** · Um Personal Task correlacionado comprova a sincronização daquele bloqueio. Uma confirmação nativa exige entidade de appointment com ID próprio, estado confirmado e correlação comprovada. O comparador de formato é automatizável. A consulta nativa e a atestação da origem exigem acesso autorizado.

## E · Concorrência entre os funis

- **Ação** · Executar as suítes de duas conexões e reproduzir a disputa pelo mesmo intervalo e profissional com os escritores reais em adaptadores ou ambientes isolados autorizados. Cobrir LL Touch, LL Brows Studio, Academy, PWYC, piloto e Campaign Studio, inclusive hold, checkout e sincronização em voo. Conferir também expiração, pagamento tardio e estado ambíguo.
- **Resultado esperado** · Um único escritor ganha a vaga ou o estado segue para revisão sem duas confirmações. A sincronização externa pode atrasar, mas a decisão deve preservar locks, calendários e ledgers.
- **Evidência exigida** · Sequência temporal redigida, dois clientes, lock observado ou guard equivalente, respostas, estados finais e prova de liberação somente após encerramento seguro.
- **Aprovação** · A prova local inclui o escritor legado sintético. O aceite de produção exige comprovar a coordenação dos escritores reais e das agendas externas. Testes concorrentes são automatizáveis com isolamento previsto. A seleção dos escritores e ambientes autorizados exige operador.

## F · Homologação do painel

- **Ação** · Exercitar o iframe existente no Chromium e testar a versão do ambiente autorizado usando dados sintéticos. Conferir autoria, edição, geração, prontidão, revisão, aprovação, programação, publicação simulada, pausa, encerramento, revogação, mensagens de erro e indicadores.
- **Resultado esperado** · HydraFacial com USD 349 regular, USD 149 oferta, USD 25 depósito e USD 124 saldo, hold de 10 min, Ludimilla e Carol, `America/New_York`. Alteração material ou revisão vencida exige nova aprovação. Navegação e marca preservadas em telas largas e móveis.
- **Evidência exigida** · Vídeos ou capturas sem dados de clientes, versões e revisões, resultado responsivo e provas das transições. Relatar o que veio de fixture, Express isolado e serviços reais autorizados.
- **Aprovação** · Todos os estados e erros reproduzíveis, ausência de duplicação na gravação e métricas sem afirmações de confirmação nativa sem suporte. Chromium e Express são automatizáveis. Aprovação clínica, preços, datas e acabamento no host de homologação passam por revisão humana.

## G · Revisão para merge

- **Ação** · Validar ZIP, SHA-256 e patch em checkout limpo do checkpoint. Revisar o diff, permissões, migrações ausentes, resultado das etapas A–F e rollback. Identificar responsáveis pelas pendências, pela operação e pela decisão de release.
- **Resultado esperado** · Patch aplicável, suíte local aprovada, artefatos e relatórios consistentes, isolamento dos projetos legados e riscos explícitos.
- **Evidência exigida** · Diff revisado, resultados de CI local e SQL, matriz de homologação e aceite registrado pelos responsáveis.
- **Aprovação** · Todas as evidências obrigatórias para esta liberação resolvidas e autorização explícita e separada para merge. Integridade é automatizável. O aceite é decisão humana.

## H · Deploy controlado

- **Ação** · Na janela autorizada, confirmar o estado do schema e configurar as variáveis globais de Render descritas em `qa/campaign-studio/FINAL-05D.md`, com gates inicialmente fechados. Implantar o backend antes dos assets Webflow. Conferir que o contrato de checkout inclui `sessionId` no ambiente de prova antes da atualização do asset.
- **Resultado esperado** · Compatibilidade de schema e assets, saúde do backend, nenhum efeito startup indevido e plano de reversão com preservação de liquidação e histórico.
- **Evidência exigida** · Revisão de release, logs redigidos, configuração de flags sem segredos, sequência de migrações, checagem do contrato e teste de rollback.
- **Aprovação** · Autorização explícita para deploy, checklist técnico aprovado e plantão definido. Saúde e contrato são automatizáveis. Implantação e ativação dos gates exigem autorização do responsável.

## I · Publicação HydraFacial USD 149

- **Ação** · Revisar a campanha real e a janela futura no painel, valores 349 / 149 / 25 / 124, capacidade, Ludimilla e Carol, hold de 10 min e timezone `America/New_York`. Aprovar a versão e sua revisão. Programar ou publicar somente na janela autorizada.
- **Resultado esperado** · Oferta correta em `/offer` e `/offer-reserve`, captura, reserva e pagamento disponíveis de acordo com as aprovações, recuperação SMS desativada.
- **Evidência exigida** · ID/versão, autor, revisão, horário, verificação de preço/visibilidade, saúde de checkout/agenda e apoio operacional. Redigir identificadores de clientes.
- **Aprovação** · Etapas A–H concluídas aplicáveis, capacidade confirmada, resultados de Stripe e agenda homologados e autorização explícita da campanha. Monitoramento e checagem de exibição são automatizáveis. A revisão comercial e a publicação exigem decisão humana.

## Evidência no código do motor de agenda

As linhas abaixo correspondem à versão reconstruída pelo patch do ZIP.

| Fluxo | Referências no código | Evidência e vínculo |
| --- | --- | --- |
| LL Brows Academy | `index.js:11707`, `:2934`, `:2947`, `:11857`, `:11958`, `:12027`, `:3804` | `/academy/confirm-session` gera ID e fingerprint determinísticos, cria evento ocupado e recupera evento existente em caso de conflito. O ledger `academy_bookings` guarda `google_event_id`, fingerprint, estado e intervalo. |
| LL Touch e LL Brows Studio | `index.js:12921`, `:13238` → `llTouchHandleAppointmentConfirmation` em `:12563`; `:12267`, `:12790`, `:12857`, `:12874`, `:12897` | O handler pago grava `lltouch_appointments`, cria evento ocupado do Google e confirma a linha após verificação. O vínculo inclui UUID interno, sessão Stripe, profissional, serviço, intervalo e `google_event_id` determinístico. |
| Pay What You Can | `index.js:11024`, `:13152`, `:13072`, `:13094`, `:13111`, `:13141` | Hold antes de pagamento em `lltouch_pwyc_checkout_holds`; o caminho em lote usa o ledger de agenda, evento determinístico e metadados de Personal Task. |
| Piloto offer-reserve | `index.js:10345`, `:10451`, `:10589`, `:10614`, `:10649` | `lltouch_offer_claims` vincula hold e Stripe. `llOfferConfirmPaidAppointment` reutiliza o mesmo motor após conciliação. |
| Campaign Studio | `index.js:8117`, `:8492`, `:8528`, `:8535`; `migrations/campaign-studio/05c-00-mapped-baseline.sql:547`; `05c-03-commercial-metrics.sql:82` | A revalidação de horário consulta fontes compartilhadas. O worker reutiliza o handler e valida o evento pelo ID, intervalo e propriedades privadas. Registra `calendar_verified`; o retorno mantém `vagaroVerified=false` e a métrica nativa indisponível. |
| Vagaro e espelhos | `index.js:2172`, `:2507`, `:12838`, `:13711` | A API encontrada consulta disponibilidade. O código reconhece eventos espelhados e documenta Google Calendar → **Vagaro Personal Task ocupado**. A descrição do evento orienta conversão para ter histórico de serviço. O webhook existente registra e acusa recebimento. |

O histórico Git inclui `bb02f7a` para Academy, `629ab54`, `4e0883a` e `c4bca52` para o motor compartilhado, `b44fd7e` para PWYC, `790b6d1` e `fa81c16` para o piloto e `3192191` para reaproveitamento pelo Campaign Studio. O repositório comprova a criação e a verificação do bloqueio no Google e documenta a sincronização para Personal Task. A homologação ainda precisa de uma leitura autenticada no Vagaro que comprove essa sincronização no ambiente e, separadamente, um ID nativo com vínculo rastreável quando se alegar confirmação nativa.

### Verificação de um agendamento histórico, exclusivamente em leitura

1. Com autorização de acesso, escolher um atendimento já concluído e localizar o UUID no ledger `academy_bookings` ou `lltouch_appointments`. Registrar o funil, profissional, serviço, intervalo UTC e horário local de Massachusetts. Para fluxo pago, consultar a sessão existente na Stripe em leitura e conferir o vínculo com claim, hold ou snapshot aplicável. Preservar os identificadores completos somente no ambiente autorizado.
2. Ler o evento pelo `google_event_id` no calendário do profissional. Conferir início/fim, estado e ocupação conforme o fluxo, além das propriedades privadas que ligam evento a booking, sessão Stripe e serviço, ou ao fingerprint da Academy. Guardar evidência redigida do bloqueio.
3. No Vagaro autorizado, localizar a entidade no mesmo estabelecimento por leitura da interface, API autenticada disponível ou export oficial. Registrar tipo da entidade, ID, estado, serviço, profissional, intervalo e correlação. Em Personal Task, registrar a correspondência com o bloqueio. Se houver appointment nativo, exigir ID distinto, estado confirmado e uma chave ou trilha confiável que ligue o ID ao booking e ao evento Google. Correspondência apenas de horário, nome ou profissional é insuficiente.
4. Para verificar a estrutura dos dados normalizados, executar localmente `node qa/campaign-studio/05d-vagaro-native-evidence.mjs <booking.json> <export-normalizado.json>`. Usar o contrato e os exemplos sintéticos de `05d-booking-evidence.test.mjs`. O verificador retorna `provenanceVerified:false` mesmo quando há correspondência estrutural. Comprovar a origem pelo acesso autenticado e pelo registro de evidência, fora do comparador.
5. Relatar separadamente pagamento, registro local, bloqueio Google, recebimento do Personal Task e confirmação nativa. Registrar data, fonte e referências redigidas. Não criar, converter, remarcar ou reenviar nenhum evento. Um atendimento histórico comprova a trilha daquele caso e deve ser combinado com a prova de concorrência da etapa E.

## Relatórios de referência

- `qa/campaign-studio/FINAL-05C.md`
- `qa/campaign-studio/FINAL-05D.md`
- `qa/campaign-studio/05d-ghl-homologation.md`
- `qa/campaign-studio/preview/README.md`
