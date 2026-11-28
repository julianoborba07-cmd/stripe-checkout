# LL Touch Campaign Studio · FINAL 05D

## Checkout e escopo da auditoria

Repositório `julianoborba07-cmd/stripe-checkout`, branch `campaign-studio-release-mapped-reservation`, `HEAD` inicial `e0f4041117bb4292baa00119ee757ad915d84040`. A auditoria começou no diretório da FINAL 05C com todas as mudanças locais presentes. Os dois anexos da tarefa 05D tinham o mesmo SHA-256. O relatório integral da entrega anterior continua no repositório. [FINAL-05C.md](FINAL-05C.md)

| Superfície da FINAL 05C no início da auditoria | Arquivos | Linhas adicionadas | Linhas removidas |
| --- | ---: | ---: | ---: |
| `index.js` e dois assets Webflow, em `git diff --numstat HEAD` | 3 | 527 | 202 |
| Módulos de aplicação novos | 4 | 617 | 0 |
| Migrações, verificações e rollback novos | 9 | 1.324 | 0 |
| Testes, fixtures e documentação novos | 13 | 2.183 | 0 |
| Total observado | 29 | 4.651 | 202 |

A contagem inclui os arquivos novos ainda fora do índice. O escopo dos números 7.548/1.066 citados na solicitação não pôde ser reproduzido a partir de `e0f4041` e desse diretório inicial. A revisão incluiu os 29 arquivos, as chamadas existentes que atravessam os módulos e o histórico local em Git do motor de agenda. O baseline SQL versionado preserva as funções homologadas em 05A. No PREVIEW, o pacote escolhe reutilizar a instalação verificada do baseline.

## Achados e correções

| Área | Achado | Correção |
| --- | --- | --- |
| Autoria e edição | A resposta atrasada de um rascunho podia preencher a seleção atual com outra campanha. Uma falha de atualização da lista após a gravação podia apresentar a operação como falha e estimular a duplicação. | O painel descarta respostas de seleções e sessões anteriores, conserva a identidade e a versão após a gravação confirmada e permite atualizar a lista separadamente. |
| Aprovação | A versão e a revisão distinguiam alterações normais do painel. A primeira aprovação ainda podia reutilizar uma revisão de termos ou imagens alteradas na mesma versão. | O banco emite um SHA-256 dos termos e assets para revisão. O servidor valida o token antes de auditar disponibilidade e o banco confere de novo sob lock antes de aprovar. O painel refaz a consulta e pede nova revisão diante de conflito. |
| Rotas administrativas | Os controles visuais e a configuração legada de captura continuavam aceitando tentativas de alteração em campanhas administradas pelo ciclo comercial. | Essas rotas exibem orientação para o ciclo comercial e retornam conflito antes da mutação. Campanhas do fluxo visual conservam os controles anteriores. A resposta de mutação comercial exige chave, versão e avanço de revisão coerentes. |
| Captura e logging | Erros de gravação podiam levar texto de exceção do banco aos logs. | A captura registra somente código validado de erro ou um código genérico e mantém a resposta pública genérica. |
| SQL e permissões | A prontidão aceitava RPCs pelo nome, o que permitia classificar uma sobrecarga incompatível como dependência presente. O checkpoint do CRM precisava também provar a identidade da linha de outbox e sua situação de conciliação. | O catálogo confere argumentos e grants conforme os contratos disponíveis. O início do efeito vincula campanha, versão, lead, lease e estado da fila sob lock. A preparação PREVIEW exige RLS, privilégios e guardas ativos. |
| Métricas | A contagem de sincronizações podia contar o mesmo contato várias vezes e pendências do CRM podiam ficar fora da revisão. | A agregação usa contatos distintos e inclui pendências persistidas do CRM. A métrica nativa de agendamento fica indisponível sem sua evidência. |
| CRM | O transporte compartilhado com o legado seguia redirecionamentos e a complementação de contato usava a política de prioridade do upsert mesmo com um ID já identificado. | O cliente comercial usa host e rotas fixos e versão de API explícita, rejeita redirecionamento, limita respostas e registra erros sem corpo. Após a busca independente por e-mail e telefone, cria por upsert ou completa os campos ausentes pelo ID. Confere identidade e tags depois da escrita antes de avançar o checkpoint. |
| Checkout e recibo | Uma sessão recuperada podia satisfazer o contrato comercial com ID divergente. A última verificação da autorização podia cruzar o vencimento do hold. A leitura do recibo verificava apenas parte do snapshot e uma nova oferta podia substituir a prova anterior do navegador. | A sessão recuperada precisa coincidir com o ID vinculado, o prazo é conferido depois da autorização e os termos do snapshot são comparados integralmente. O recibo preserva a prova vinculada ao checkout. A conciliação exige vínculo entre Charge e PaymentIntent. |
| Disponibilidade e booking | Um hold antigo podia chegar ao Stripe depois de uma alteração na agenda compartilhada. Uma tentativa ambígua de criar o evento no Google podia liberar cedo a proteção interna. | O primeiro checkout revalida o horário e as fontes compartilhadas imediatamente antes da emissão. Na confirmação mapeada, a criação ambígua mantém o registro sob revisão e tenta reconciliação pelo ID determinístico com prova do evento. As verificações do fluxo anterior permanecem nos pontos de entrada existentes. |

### Superfícies revisadas

- As rotas administrativas continuam atrás do Basic Auth existente. Verifiquei validação da origem nas mutações, confirmação explícita e revisão vinculada à versão. O iframe tem um único script com nonce, conexões da própria origem e `frame-ancestors` restrito aos hosts existentes. A identidade de auditoria segue o usuário administrativo configurado.
- O fluxo público verifica origem, campanha, versão, nonce, lead, hold, snapshot, sessão e estado. A retenção de casos ambíguos evita nova cobrança ou nova confirmação presumida. Os workers da emissão e da recuperação continuam separados. A reconciliação de operações anteriores usa seus gates próprios para permitir fechamento seguro após desligar novas vendas.
- Foram examinados RLS, funções visíveis ao `service_role`, ausência de grants para `anon` e `authenticated` nos RPCs candidatos, exclusão de intervalos ativos, snapshots imutáveis, locks de ciclo comercial, permissões do outbox e proteção do histórico no rollback. Os testes locais usam substitutos declarados para RPCs legados ausentes do repositório.
- O painel e os assets públicos permanecem nos pontos de entrada existentes. O adaptador do iframe preserva o template base e mantém a lógica de autoria legível. A duplicação aparente do baseline 05A no instalador 00 é necessária para instalação limpa sem dados de QA. O PREVIEW reutiliza o baseline já instalado e verificado.

## Motor original e evidência Vagaro

| Fluxo | Caminho encontrado no histórico e no código | Evidência persistida |
| --- | --- | --- |
| LL Brows Academy | `bb02f7a` e `/academy/confirm-session` usam a agenda do Google e validam o horário. As impressões digitais da reserva e as verificações da agenda evitam repetições no fluxo. | `academy_bookings`, fingerprint, intervalo, estado e referência de evento Google. |
| LL Touch e LL Brows Studio | `629ab54`, `4e0883a` e `c4bca52` estruturam `llTouchHandleAppointmentConfirmation`. A confirmação verifica Stripe e disponibilidade, grava a linha de agendamento e cria um evento Google ocupado. | `lltouch_appointments` com `id`, `stripe_session_id`, `provider_id`, `service_id`, intervalo e `google_event_id` determinístico. |
| Pay What You Can | `b44fd7e` acrescenta hold antes do pagamento. As variantes em lote e recuperação usam a mesma agenda e registros de atendimento. | `lltouch_pwyc_checkout_holds`, vínculo Stripe e agendamentos do ledger compartilhado. |
| Piloto `offer-reserve` | `790b6d1` e `fa81c16` usam o ledger `lltouch_offer_claims` e a confirmação do motor original após liquidação da Stripe. O modo de preferência mantém tratamento próprio. | Claim, sessão Stripe, intervalo, estado da conciliação, vínculo ao registro de agenda. |
| Campaign Studio | `3192191` liga a emissão mapeada e o worker ao mesmo `llTouchHandleAppointmentConfirmation`. `027bf70` usa a evidência do ledger para supressão de recuperação. | Hold e snapshot imutáveis, ledger de emissão, agendamento local e vínculo do booking mapeado. |

A API Vagaro encontrada consulta o catálogo e a disponibilidade. O código existente documenta a sincronização de um evento ocupado do Google Calendar para um *Personal Task* no Vagaro. As descrições orientam converter o *Personal Task* em agendamento quando o histórico de serviço for necessário. `/vagaro/webhook` registra e acusa recebimento. Esse caminho não persiste um identificador nativo de agendamento nem concilia sua confirmação.

A ausência de prova nativa foi verificada também no histórico local. A busca por identificadores de appointments, pela criação de eventos e pelos handlers de agenda localizou caminhos de disponibilidade e criação no Google. A evidência pendente é um registro de agendamento nativo obtido de uma origem Vagaro autenticada ou de um export oficial controlado, com ID próprio, estabelecimento, profissional, serviço, intervalo, estado e chave de correlação com o booking e o evento Google. Vincular um *Personal Task* ao horário prova ocupação, sem resolver o estado nativo.

O verificador local `node qa/campaign-studio/05d-vagaro-native-evidence.mjs <booking.json> <export-normalizado.json>` compara dados previamente normalizados. Ele identifica inconsistências, ausência e ambiguidade e retorna `provenanceVerified:false` mesmo quando a estrutura coincide. A homologação deve anexar evidência da origem do export ou da leitura autenticada. Use o contrato e os dados sintéticos do teste como exemplo. [05d-booking-evidence.test.mjs](05d-booking-evidence.test.mjs)

## Concorrência entre funis

O hold mapeado protege o intervalo por exclusão e usa locks transacionais em namespace compartilhado com o piloto e por profissional. A checagem de disponibilidade combina a fonte Vagaro, a agenda Google e os ledgers Supabase. A revalidação antes do primeiro checkout e do booking inclui as reservas ativas relevantes dos demais funis e mantém o vínculo ao snapshot.

O teste com duas conexões observou a RPC mapeada aguardar um escritor sintético do piloto sob `pg_advisory_xact_lock(5520261105)`. Depois do commit do escritor, a RPC recusou a sobreposição. O cenário mapeado contra mapeado verificou espera e retomada após rollback. O DDL do escritor legado real está fora do checkout. Academy, os escritores externos e as alterações manuais em Google/Vagaro também não participam da mesma transação PostgreSQL. A prova integrada restante é observar conflito real entre os escritores de cada funil para o mesmo profissional e intervalo, inclusive durante pagamento, atraso ou falha da sincronização.

## Pacote SQL para PREVIEW

O pacote tem inventário `01_PREFLIGHT_PREVIEW.sql`, verificação de funções e privilégios, harness transacional e concorrente, inspeção final dos ledgers e rollback. Ele referencia as quatro fontes originais numeradas e verifica o catálogo antes de propor qualquer instalação. O resultado esperado para o ambiente descrito é baseline 19/19 verificado e `05c-00` pulado. Candidatas `05c-01`, `05c-02` e `05c-03` entram somente quando estiverem ausentes, nessa ordem. Instalação parcial ou divergente requer inspeção do histórico e dos grants. [Pacote PREVIEW](preview/README.md)

## GoHighLevel

O cadastro, atualização seletiva, tags, consentimento e checkpoints foram exercitados com respostas sintéticas. Origem, campanha, versão e consentimentos permanecem vinculados ao lead no Supabase. As escritas de contato omitem campos de marketing, DND e opt-out. O checklist externo reúne a localização autorizada, escopos, prioridade de duplicatas, contrato de consulta e escrita, readback das tags, inventário de workflows e comprovação de zero disparos. Também exige validar a semântica de campos omitidos no PUT e a concorrência com alterações de contatos feitas por outros escritores. O estado informado para o workflow de 10 minutos é rascunho e precisa de verificação externa. [Checklist GHL](05d-ghl-homologation.md)

## Homologação comercial e ordem de liberação

1. Revisar a branch e o relatório de testes. Conferir a revisão das migrações, o plano de rollback e a autorização explícita do responsável pelo PREVIEW. Validar inventário e baseline com o pacote SQL.
2. Em alvo autorizado, instalar somente as candidatas ausentes na ordem 01 → 02 → 03, com gates fechados. Rodar verificação de catálogo e consistência e homologar os RPCs legados reais em clone descartável sem dados de clientes. Confirmar criação e edição de rascunhos, token, execução de locks, captura e estados de outbox no schema real.
3. Validar no PREVIEW o mesmo iframe e os dois assets públicos do Webflow. Testar criação, geração de conteúdo, edição, erro de prontidão, aprovação, programação, publicação simulada, pausa, encerramento, revogação e métricas. A primeira referência é HydraFacial com USD 349 regular, USD 149 oferta, USD 25 depósito, USD 124 saldo, 10 minutos, Ludimilla e Carol e `America/New_York`.
4. Executar a ficha externa GHL em localização de teste autorizada. Exigir readback de identidade, deduplicação, tags e ausência de inscrições ou mensagens indevidas. Confirmar que o workflow de recuperação continua em rascunho.
5. Homologar Stripe com assinatura e bindings verificados em ambiente isolado. Repetir emissão, webhook, atraso, expiração e divergência de valor. Conservar casos ambíguos em revisão. Homologar disponibilidade e concorrência com os escritores reais de todos os funis. Obter evidência nativa Vagaro e confirmar que o comprovante e métricas distinguem os estados.
6. Revisar o aceite dos responsáveis e a prontidão de operação. Autorizar separadamente merge e deploy. Implantar primeiro o backend e conferir que o contrato de checkout devolve `sessionId`. Atualizar depois os assets Webflow, que usam esse campo para provar a sessão antes do redirecionamento. Manter gates fechados durante a troca e confirmar startup, saúde, rollback e visibilidade antes de qualquer ativação operacional.
7. Ativar os gates aprovados somente na janela e no ambiente autorizados. Revisar e aprovar a versão real de HydraFacial em uma ação administrativa separada. Publicação real requer autorização própria e validação da janela e da capacidade.

### Configuração global no Render

| Componente | Configuração a conferir após homologação |
| --- | --- |
| Autoria e Supabase | `LLTOUCH_CM_ADMIN_USER`, `LLTOUCH_CM_ADMIN_PASSWORD`, `SUPABASE_URL`, `SUPABASE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY` e opção `LLTOUCH_CM_AI_MODEL`. Segredos somente no ambiente autorizado. |
| Novas vendas e captura | `LLTOUCH_CM_COMMERCIAL_RELEASE_APPROVED`, `LLTOUCH_CM_PUBLIC_LEADS_ENABLED`, `LLTOUCH_CM_03C11E_RELEASE_ENABLED`, `LLTOUCH_CM_MAPPED_RESERVATION_ENABLED` e `LLTOUCH_CM_MAPPED_CHECKOUT_ENABLED`. A versão comercial também exige autorização no banco. |
| Stripe e workers | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `LLTOUCH_CM_MAPPED_EXPIRY_WORKER_ENABLED`, `LLTOUCH_CM_MAPPED_BOOKING_ENABLED`, `LLTOUCH_CROSS_SERVICE_CONSTRAINT_READY` e `LLTOUCH_CM_MAPPED_BOOKING_HOMOLOGATED`. A liberação depende das provas de concorrência e sincronização. |
| Vagaro e Google Calendar | `VAGARO_CLIENT_ID`, `VAGARO_CLIENT_SECRET`, `VAGARO_BUSINESS_ID`, `VAGARO_REGION`, `VAGARO_SCOPE`, `VAGARO_LUDIMILLA_PROVIDER_ID`, `VAGARO_CAROL_PROVIDER_ID`, `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY`, `GOOGLE_CALENDAR_ID`, `GOOGLE_CALENDAR_CAROL_ID` e `GOOGLE_CALENDAR_TIMEZONE=America/New_York`. Verificar o serviço e a duração autorizada para cada profissional. |
| CRM | Credenciais escopadas e ID verificado da localização, aprovações globais, modo `pilot` ou `approved` conforme a ficha, release e bloqueio de emergência. [Checklist GHL](05d-ghl-homologation.md) |
| QA e recuperação | Manter envs privados de QA segregados dos gates comerciais. `LL_CM_MAPPED_RECOVERY_SEED_RELEASED` e `LL_CM_RECOVERY_CALLBACK_RELEASED` permanecem `false`. Manter `LLTOUCH_CM_MAPPED_RECOVERY_SEED_ENABLED`, `LLTOUCH_CM_RECOVERY_CALLBACK_ENABLED` e workflow de recuperação desativados. |

### Rollback e critérios de aceite

Fechar novas vendas e novos efeitos CRM, revogar ou pausar a versão afetada, conservar webhook e liquidação até conciliar sessões em voo e preservar snapshots, disputas e trilha de auditoria. Uma instalação usada fica em rollback operacional, com registros intactos. Uma instalação candidata comprovadamente sem histórico pode remover 03 → 02 → 01 sob manutenção e repetir a verificação do baseline. O rollback de 00 é reservado a uma instalação nova e comprovadamente vazia daquele próprio instalador. [Rollback PREVIEW](preview/README.md#07--rollback-seguro)

O aceite para merge/deploy exige checkout revisado, suítes locais verdes, compatibilidade real de RPCs e grants, confirmação separada de cada integração, evidência de concorrência entre os escritores reais, operação Stripe reproduzível e revisão formal de alcance e rollback. A 05D entrega código e testes locais. Permanecem pendentes a execução autorizada no PREVIEW, a validação externa do GHL, a homologação Stripe/Vagaro/Google e a prova nativa/cross-funnel. Com esses bloqueios, os gates comerciais continuam fechados e a publicação real fica pendente de autorização.

## Arquivos alterados pela 05D

| Grupo | Arquivos |
| --- | --- |
| Aplicação e Webflow | `index.js`, `lltouch-campaign-webflow-v1/admin-commercial-v1.mjs`, `lltouch-campaign-webflow-v1/offer-mapped-v1.js`, `lltouch-campaign-webflow-v1/offer-reserve-mapped-v1.js` |
| Contratos de aplicação | `lltouch-cm-commercial-v1.mjs`, `lltouch-cm-ghl-contact-v1.mjs`, `lltouch-cm-mapped-payment-v1.mjs`, `lltouch-cm-booking-evidence-v1.mjs` |
| SQL candidato | `migrations/campaign-studio/05c-01-commercial-authorization.sql`, `05c-02-commercial-ghl-effects.sql`, `05c-03-commercial-metrics.sql` e `rollback/05c-01-commercial-authorization.sql` |
| Testes atualizados | `lltouch-cm-mapped-payment-v1.test.mjs`, `qa/campaign-studio/05c-authorization.test.sql`, `05c-authorization.verify.sql`, `05c-authorization-concurrency.integration.mjs`, `05c-commercial.test.mjs`, `05c-ghl-contact.test.mjs`, `05c-ghl-effects.test.sql`, `admin-commercial-v1.test.mjs`, `commercial-lifecycle.integration.test.mjs`, `fixtures/local-schema.sql`, `mapped-lifecycle.integration.sql` e `offer-reserve-mapped-v1.test.mjs` |
| Testes e evidências novos | `qa/campaign-studio/05d-booking-concurrency.integration.mjs`, `05d-booking-evidence.test.mjs` e `05d-vagaro-native-evidence.mjs` |
| Entrega e homologação | `qa/campaign-studio/FINAL-05D.md`, `05d-ghl-homologation.md` e `preview/` com `01_PREFLIGHT_PREVIEW.sql`, `03_VERIFICAR_FUNCOES_PREVIEW.sql`, `06_VERIFICACAO_FINAL_PREVIEW.sql`, `README.md` e `testar-sql-local.sh` |

## Resultados e comandos executados

| Verificação | Resultado final |
| --- | --- |
| Suíte Node em Docker sem rede externa | 60 casos descobertos, 59 aprovados e 1 caso Chromium pulado pela ausência do navegador na imagem. O caso foi aprovado na execução Chromium separada. Inclui 15 cenários Express, 18 testes do conector CRM, 6 testes de evidência Vagaro/Google e regressão de recuperação com 21 verificações internas. |
| Chromium com tráfego interceptado | 2 de 2 aprovados. Autoria, edição, geração, prontidão, aprovação, programação, publicação simulada, pausa, revogação, reabertura, encerramento, métricas e erros. A fixture HydraFacial usa os valores de referência. Testou o iframe sob CSP, redimensionamento e identidade existente em 1200, 820 e 390 px. As APIs foram simuladas no navegador, com Express testado separadamente. |
| PostgreSQL 17.12 isolado | 35 asserções de autorização, 10 de CRM, suíte transacional mapeada, catálogo de 16 funções candidatas, 2 ledgers com RLS e 4 triggers. Passaram os cenários de concorrência administrativa, revogação versus captura legada, hold contra hold e hold contra escritor legado sintético. O rollback de uma instalação sem uso preservou o baseline, e a verificação final não encontrou fixtures ou filas residuais. |
| Regressões existentes | 12 saídas de PDF do smoke LLMK e bloqueio da assinatura live em espanhol. O Express exercitou rotas legadas da Academy, oferta e checkout. O diff confirma preservação dos manifests, cron da Academy, contratos LLMK, 05A e autorização de recuperação. |
| Comandos estáticos | `git diff --check`, `node --check index.js` e `bash -n qa/campaign-studio/preview/testar-sql-local.sh` aprovados. |

Uma execução intermediária expôs a necessidade de executar o wrapper GHL com permissões controladas mesmo quando `service_role` não tem `UPDATE` direto na fila. O wrapper e o verificador de catálogo foram corrigidos e revalidados com o grant direto removido. O inventário local retorna 12/19 RPCs do baseline e 0/1 de autoria porque o repositório dispensa a implementação real de sete RPCs legados de CRM e do RPC de autoria em sua fixture. Esse cenário verifica a recusa da prontidão com dependências incompletas.

```bash
git diff --check
node --check index.js

docker run --rm --pull=never --network none --read-only \
  --mount "type=bind,source=$PWD,target=/repo,readonly" node:24-bookworm-slim \
  sh -ec 'node --test /repo/qa/campaign-studio/*.test.mjs /repo/lltouch-cm-mapped-payment-v1.test.mjs /repo/lltouch-cm-recovery-authorize-v1.test.mjs'

LL_CM_UI_PLAYWRIGHT=/caminho/do/playwright LL_CM_UI_CHROMIUM=/caminho/do/chromium \
  node --test --test-timeout=20000 qa/campaign-studio/admin-commercial-v1.test.mjs

bash -n qa/campaign-studio/preview/testar-sql-local.sh
bash qa/campaign-studio/preview/testar-sql-local.sh
```

O smoke `node qa-llmk/node_smoke_test.mjs` foi executado em cópia temporária no contêiner sem rede. Os testes usaram dados sintéticos. O ambiente de trabalho foi preservado para revisão, sem operações em bancos externos, integrações de produção, cobranças, agendamentos, SMS, publicação, push, merge ou deploy.
