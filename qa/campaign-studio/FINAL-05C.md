# LL Touch Campaign Studio · FINAL 05C

## Base e escopo

Repositório `julianoborba07-cmd/stripe-checkout`, branch `campaign-studio-release-mapped-reservation`, checkpoint inicial `e0f4041117bb4292baa00119ee757ad915d84040`. O checkout inicial `work` estava limpo no mesmo commit de `origin/main`, `74ec278`. A branch solicitada foi localizada via Git, conferida no remoto e selecionada antes da edição.

Esta entrega reúne o código candidato da etapa comercial. A homologação integrada e a autorização de produção são etapas posteriores. Toda a execução ocorreu no ambiente isolado com dados sintéticos.

## Fluxo candidato

- O iframe existente em `/lltouch/campaigns/admin/webflow-studio` reutiliza a autoria e a geração de IA atuais. Oferece catálogo, valores em USD, depósito editável, saldo calculado, criativos, janela e revisão. A configuração aprovada habilita serviços mapeados de sessão única com duração verificada, Ludimilla e Carol, e hold de 10 minutos. Pacotes, áreas variáveis e limites de quantidade ficam pendentes de contrato e ledger apropriados.
- A aprovação exige Basic Auth existente, confirmação explícita, revisão comercial e auditoria de uma data com Vagaro, Google Calendar e Supabase para os dois profissionais. A auditoria inicial é uma amostra. As consultas de clientes e a criação de holds voltam a verificar os horários.
- A autorização usa versão da campanha e revisão da autorização. O banco verifica as duas sob lock, registra o ator autenticado e mantém o histórico. Mudanças em termos, versão ou criativos invalidam aprovações. O ator corresponde ao usuário Basic configurado. Uma instalação que exige atribuição individual precisa provisionar identidades distintas.
- Publicação imediata usa a janela vigente. Programação usa o início futuro já revisado, em `America/New_York`. O fluxo mantém a regra de uma publicação universal por vez, inclusive quando programada. Pausa e encerramento tiram a oferta da página. A revogação bloqueia novas operações e permite que a publicação existente continue visual até pausa ou encerramento.
- `/offer` mostra a oferta vigente e a captura habilitada. Uma versão comercial só aceita leads com autorização ativa e configuração de captura correspondente. O RPC existente registra dados e consentimentos, e o nonce permite repetir a mesma submissão sem novo lead. `/offer-reserve` usa a mesma versão, consulta disponibilidade, retém o horário por 10 minutos e abre Stripe com os termos do snapshot. A opção de preferência existente permanece disponível nos fluxos já compatíveis. O plano comercial mapeado informa somente horários verificáveis.
- A sincronização CRM usa a fila atual e efeitos registrados antes de cada operação externa. O upsert cria contatos novos ou completa dados ausentes do mesmo contato. Identidades conflitantes exigem revisão. O CRM recebe `lltouch-cm-lead` e uma tag específica existente quando aplicável. A captura mantém origem, campanha, versão e os consentimentos do formulário no Supabase. O backend conserva DND, opt-out e preferências de marketing já registradas no GHL.
- Stripe usa idempotência por snapshot. A conciliação confere sessão, intenção, valor, moeda e janela do hold. Eventos repetidos usam o ledger. Expiração ou pagamento ambíguo exige confirmação da Stripe. Pagamento tardio ou divergente fica em revisão. A retomada de um agendamento pago reaproveita o motor original e nunca emite uma nova cobrança.
- O motor existente pode verificar o bloqueio de agenda do Google Calendar. O comprovante e o painel registram isso como bloqueio de calendário, e a confirmação nativa no Vagaro permanece indisponível até haver evidência independente. O recibo exige os identificadores vinculados da sessão de navegação e retorna somente o estado da operação.
- Os indicadores agregam todas as versões da campanha com base nos ledgers. Conversões são leads distintos com depósito conciliado. Falhas de integração contabilizam as falhas registradas no CRM. A fila de conciliação inclui holds ou pagamentos em revisão e operações externas sem desfecho após o prazo. Métricas cuja evidência está indisponível ficam sem valor.

## Arquivos e migrações

| Arquivo | Finalidade |
|---|---|
| `index.js` | Orquestração do painel, autorização, captura, CRM, disponibilidade, Stripe, recibo e booking. |
| `lltouch-campaign-webflow-v1/admin-commercial-v1.mjs` | Controles comerciais incorporados ao iframe existente. |
| `lltouch-campaign-webflow-v1/offer-mapped-v1.js` e `offer-reserve-mapped-v1.js` | Entrada da oferta, seleção, retomada do hold e consulta de estado do depósito. |
| `lltouch-cm-commercial-v1.mjs` | Validação das ações administrativas e da auditoria de disponibilidade. |
| `lltouch-cm-ghl-contact-v1.mjs` | Verificação de identidade, atualização seletiva e deduplicação de efeitos do CRM. |
| `lltouch-cm-mapped-payment-v1.mjs` | Contratos de Stripe e estados seguros do recibo. |
| `migrations/campaign-studio/05c-00-mapped-baseline.sql` | Instalação candidata do baseline mapeado quando todas as funções e ledgers mapeados estão ausentes. |
| `migrations/campaign-studio/05c-01-commercial-authorization.sql` | Autorização, auditoria, invalidação e integração transacional da captura. |
| `migrations/campaign-studio/05c-02-commercial-ghl-effects.sql` | Autoriza o início de cada efeito CRM sob o mesmo lock da revogação. |
| `migrations/campaign-studio/05c-03-commercial-metrics.sql` | Indicadores dos ledgers e verificação de disponibilidade e privilégios dos RPCs de que o fluxo depende, sem retorno de PII. |
| `migrations/campaign-studio/verify/05c-00-mapped-baseline.sql` | Verificação de versão, grants, RLS, constraints e imutabilidade do baseline. |
| `migrations/campaign-studio/rollback/` | Procedimentos SQL de reversão com proteção do histórico. |
| `qa/campaign-studio/` e `lltouch-cm-mapped-payment-v1.test.mjs` | Testes sintéticos unitários, navegador, Express e PostgreSQL. |

O baseline `qa/campaign-studio/05a-commercial-install-preview.sql` segue reservado ao PREVIEW. A instalação candidata depende do esquema de campanhas e assets, leads e configuração de captura, holds e snapshots, appointment ledger, exclusão de intervalos ativos, trigger de imutabilidade, e dos RPCs legados de autoria, captura e fila CRM. As definições legadas ausentes no checkout têm substitutos declarados em `fixtures/local-schema.sql` para o teste descartável. Verifique os contratos e grants das versões realmente instaladas em PREVIEW antes de promover a candidata.

## Configuração global e sinais de liberação

**Comercial** · `LLTOUCH_CM_COMMERCIAL_RELEASE_APPROVED`, `LLTOUCH_CM_MAPPED_RESERVATION_ENABLED`, `LLTOUCH_CM_MAPPED_CHECKOUT_ENABLED`, `LLTOUCH_CM_MAPPED_EXPIRY_WORKER_ENABLED` e `LLTOUCH_CM_MAPPED_BOOKING_ENABLED` exigem valor explícito `true` e ficam fechados por padrão. Nova venda também exige os dois calendários/configurações do motor, credenciais Stripe live e segredo do webhook configurados, autorização por versão e portões da captura `LLTOUCH_CM_PUBLIC_LEADS_ENABLED` e `LLTOUCH_CM_03C11E_RELEASE_ENABLED`. Os modos privados de QA devem estar desligados para o ambiente de liberação comercial. O `SUPABASE_SERVICE_ROLE_KEY` e as credenciais do painel e das integrações ficam restritos ao backend.

**Autoria** · O endpoint de geração existente usa `OPENAI_API_KEY` e aceita `LLTOUCH_CM_AI_MODEL` como ajuste global. Valide os RPCs reais de autoria com os novos valores no PREVIEW. Os testes de interface simularam a geração e a gravação do rascunho.

**Agenda** · A operação depende de evidência integrada para `LLTOUCH_CM_MAPPED_BOOKING_HOMOLOGATED` e do pré-requisito existente `LLTOUCH_CROSS_SERVICE_CONSTRAINT_READY`. O código verifica o catálogo e a duração para cada profissional, disponibilidade Vagaro, Google Calendar e os ledgers Supabase de Campaign Studio, piloto, LL Touch, Academy e PWYC quando relevantes. A exclusão existente protege concorrência no ledger mapeado. A coordenação com todos os escritores independentes e a confirmação nativa no Vagaro estão pendentes de comprovação. Mantenha a liberação fechada enquanto essas evidências faltarem.

**CRM** · Revise a localização única, `LLTOUCH_GHL_PRIVATE_TOKEN`, `LLTOUCH_GHL_LOCATION_ID` e `LLTOUCH_CM_GHL_VERIFIED_LOCATION_ID` vinculados à homologação. Verifique permissões de leitura/escrita de contato, política de duplicatas, semântica de “sem contato” e workflows por criação, atualização e cada tag da campanha. O modo de operação universal usa `LLTOUCH_CM_GHL_AUTO_MODE=approved` com `LLTOUCH_CM_GHL_03C11RC_CONTINUOUS_APPROVED=true`, `LLTOUCH_CM_GHL_AUTO_WORKER_ENABLED=true`, `LLTOUCH_CM_GHL_AUTO_RELEASE_APPROVED=true`, `LLTOUCH_CM_GHL_AUTO_WORKFLOW_SAFETY_APPROVED=true`, `LLTOUCH_CM_GHL_03C11RE_EFFECTS_APPROVED=true`, `LLTOUCH_CM_GHL_SYNC_ENABLED=true`, `LLTOUCH_CM_GHL_RELEASE_APPROVED=true` e `LLTOUCH_CM_GHL_EMERGENCY_STOP=false`. Preserve o modo piloto para cenários restritos. Controles de emergência e aprovações globais são operacionais. Novas campanhas usam o painel.

**Recuperação** · `LL_CM_MAPPED_RECOVERY_SEED_RELEASED=false` e `LL_CM_RECOVERY_CALLBACK_RELEASED=false` continuam fixos no código. As variáveis subordinadas `LLTOUCH_CM_MAPPED_RECOVERY_SEED_ENABLED` e `LLTOUCH_CM_RECOVERY_CALLBACK_ENABLED` permanecem desativadas. O worker comercial de contatos e tags funciona sem integração de envio com o workflow de recuperação. Preserve em rascunho `LL Touch | Campaign Studio | Lead Recovery | 10 Min`.

## Homologação integrada e ordem de implantação

1. Conferir o diff e os resultados locais. Inventariar no PREVIEW os RPCs, estados, grants, triggers, locks e constraints em uso. Aplicar `05c-00` apenas em alvo com baseline mapeado ausente e pré-requisitos verificados. Validar a equivalência da instalação já existente antes de pular esse passo. Aplicar `05c-01`, `05c-02` e `05c-03` em ordem, com gates fechados.
2. Executar a homologação de autoria e edição no painel existente, incluindo depósito configurável, expiração, edição material, concorrência, revogação e captura. Verificar que Webflow usa `offer-mapped-v1.js` e `offer-reserve-mapped-v1.js` nos selects e caminhos existentes. Validar iframe, CORS, comunicação Render–Supabase, desktop e mobile.
3. Validar em modo controlado GHL a deduplicação, tags, preservação de consentimentos, estados após erro e segurança do workflow. Usar ambiente ou localização aprovada de teste. Verificar ausência de inscrições automáticas em workflows de mensagens e manter o workflow de recuperação em rascunho.
4. Testar disponibilidade e conflitos cruzados com as integrações homologadas e nos horários comerciais reais de Massachusetts. Cobrir bloqueios, duração, feriados, mudanças de horário, mesma vaga em dois funis, cadastros externos concorrentes e sincronização Vagaro↔Google. Confirmar por fonte nativa todo estado apresentado ao cliente como agendamento confirmado.
5. Testar o caminho Stripe com fixtures assinadas e, em homologação autorizada, sandbox e schema isolados. Validar idempotência, assinatura, valor, duplicação, atraso, expiração, ambiguidade e falhas após o pagamento. O baseline atual usa IDs `cs_live_` para o caminho comercial e tem diagnósticos QA separados. O desenho da homologação segura deve respeitar esse contrato ou usar shims de Stripe no ambiente de integração.
6. Revisar bloqueios e caminho de rollback com operadores e donos dos serviços. Solicitar autorização explícita para merge e deploy após a validação do PREVIEW, verificação das migrações e plano de rollback. Implantar backend e assets com gates fechados. A aprovação para ativar as integrações e a publicação de uma campanha são decisões explícitas de operação.

## Primeira campanha HydraFacial

Usar `hydrafacial-piloto-qa` como cenário de referência. Conferir o valor regular de US$ 349, a oferta de US$ 149, o depósito de US$ 25 e o saldo de US$ 124. Revisar novas datas em `America/New_York`, plano e criativos, mapear HydraFacial para o serviço existente, verificar Ludimilla e Carol e confirmar o hold de 10 minutos. Após a homologação integrada, autorizar explicitamente a versão atual no painel. Confirmar a publicação imediata ou agendada para a janela revisada. `e0f4041` preserva a referência em rascunho e a execução local usou fixtures isoladas.

## Rollback e operação de exceções

1. Fechar `LLTOUCH_CM_COMMERCIAL_RELEASE_APPROVED`, reserva e checkout para interromper novas vendas. Usar o painel para revogar e pausar as versões afetadas. Usar o bloqueio de emergência do GHL se houver efeito externo indevido.
2. Preservar webhook, conciliação, snapshot e ledger de atendimento para depósitos existentes. Avaliar cada Stripe Session com estado de emissão incerto, cada pagamento tardio e cada booking em revisão. Preservar o bloqueio de horários ambíguos até confirmação. Operar reembolso e reconciliação somente mediante autorização adequada.
3. Reverter a aplicação somente após esvaziar ou transferir com segurança o processamento em voo. Em instalação sem uso, os scripts SQL de `rollback/` seguem a ordem reversa `05c-03` → `05c-02` → `05c-01` → `05c-00` quando aplicável. Instalações com histórico conservam os registros e as migrações persistentes. Exija evidência de ausência de pendências antes de desabilitar os workers de liquidação.

## Pendências da etapa SMS

Homologar elegibilidade positiva, consentimento explícito para SMS, DND/opt-out, supressão por pagamento interno ou externo e por reserva existente. Finalizar a autenticação e a reserva de uso único do callback, testar replay concorrente e reconciliar o resultado de envio com o ledger. Verificar branch de contato inexistente, efeitos anteriores ambíguos e resposta de opt-out. Revisar e autorizar o workflow separadamente após homologação. O envio continua desativado.

## Evidências da execução isolada

| Verificação | Resultado |
|---|---|
| Startup real do Express com env sintético, SDKs interceptados e rede externa desabilitada | Gates fechados no padrão e nenhum job comercial inicializado. Os scripts de startup padrão e o cron de lembretes da Academy foram inspecionados por leitura. |
| Node em contêiner sem rede | 41 testes aprovados. Um teste Chromium ausente nessa imagem foi executado separadamente com sucesso. A suíte inclui 11 cenários Express e um arquivo de regressão com 21 cenários de recuperação. |
| Chromium com todas as rotas externas interceptadas | 2 testes aprovados. O iframe existente foi exercitado em 1200, 820 e 390 px, com autoria, revisão, ações por versão, retorno a rascunho e métricas. |
| PostgreSQL 17 descartável por socket Unix | Instalação das quatro migrações, verificação de catálogo, 34 asserções de autorização, 20 grupos de verificações compostas e concorrência administrativa com duas conexões. Captura, holds concorrentes, Stripe, booking em revisão, CRM, métricas e rollback aprovados. |
| Regressões | Rotas existentes da Academy, LL Touch e contratos exercitadas no Express. Smoke LLMK gerou 12 PDFs sintéticos e confirmou o bloqueio de assinatura em espanhol. `node --check` e `git diff --check` aprovados. |
| Homologação externa | Pendente para persistência e RPCs legados reais do PREVIEW, Webflow publicado, IA, GHL, Stripe, Vagaro e Google Calendar. A confirmação nativa e a concorrência entre todos os funis permanecem bloqueios explícitos. |

Os testes locais expuseram e permitiram corrigir o overload do lock de publicação em PostgreSQL. O fluxo HTTP repetiu o checkout e recuperou a sessão existente. Casos de estado divergente, valor incorreto, autorização revogada, efeito CRM sem confirmação e falha do booking após pagamento terminaram em estado de bloqueio ou revisão verificável.

Comandos a partir da raiz, usando dependências locais já instaladas e a imagem Node disponível no Docker.

```bash
git diff --check
node --check index.js
node --check lltouch-campaign-webflow-v1/offer-mapped-v1.js
node --check lltouch-campaign-webflow-v1/offer-reserve-mapped-v1.js

docker run --rm --pull never --network none --read-only \
  --mount "type=bind,source=$PWD,target=/repo,readonly" --workdir /repo \
  node:24-bookworm-slim node --test lltouch-cm-mapped-payment-v1.test.mjs \
  lltouch-cm-recovery-authorize-v1.test.mjs qa/campaign-studio/*.test.mjs

LL_CM_UI_PLAYWRIGHT=/caminho/do/playwright LL_CM_UI_CHROMIUM=/caminho/do/chromium \
  node --test qa/campaign-studio/admin-commercial-v1.test.mjs

node qa-llmk/node_smoke_test.mjs
```

O smoke LLMK foi executado com `qa-llmk/` em uma cópia temporária dentro do contêiner. Para SQL, use um contêiner PostgreSQL 17 descartável com `--network none` e conexão via socket Unix. Carregue `fixtures/local-schema.sql`, as migrações `05c-00` a `05c-03` e então `05c-authorization.verify.sql`, `05c-authorization.test.sql`, `05c-ghl-effects.test.sql` e `mapped-lifecycle.integration.sql`, via `docker exec -i <contêiner> psql -X -v ON_ERROR_STOP=1 -U postgres -d <banco_qa> < <arquivo>`. O teste de concorrência usa o banco dedicado `lltouch_authorization_qa` com `LL_CM_TEST_PG_CONTAINER=<contêiner> node qa/campaign-studio/05c-authorization-concurrency.integration.mjs`. Use o verificador de baseline antes da instalação e após o rollback para confirmar `ABSENT` na base descartável.
