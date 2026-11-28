# Campaign Studio · Homologação SQL no Supabase PREVIEW

Este pacote usa o baseline das 19 funções já instaladas no PREVIEW. Os SQL de catálogo e verificação retornam contratos e contagens agregadas. Os testes de escrita usam um PostgreSQL descartável, com dados sintéticos e rede desabilitada.

## 01 · Inventário somente leitura

Após autorização específica para a homologação no PREVIEW, confirme a referência do projeto e o destino da sessão administrativa. Execute [01_PREFLIGHT_PREVIEW.sql](01_PREFLIGHT_PREVIEW.sql) e [a verificação do baseline mapeado](../../../migrations/campaign-studio/verify/05c-00-mapped-baseline.sql) separadamente. Ambos aceitam o SQL Editor ou `psql -X -v ON_ERROR_STOP=1 -f <arquivo>` na conexão previamente conferida.

| Resultado exigido | Decisão |
| --- | --- |
| `baseline` 19 de 19, `authoring` 1 de 1 e `blockers={}` | Os argumentos RPC coincidem com o contrato adotado pelo backend. Preserve as funções existentes. |
| Todas as relações presentes e `missing_columns={}` | Prossiga à verificação do baseline. |
| Baseline `VERIFIED`, exclusão de holds e imutabilidade de snapshots verdadeiras | Pule `05c-00` no PREVIEW. |
| `ABSENT`, `PARTIAL` ou `DIFFERENT` para o baseline esperado no PREVIEW | Interrompa e compare o projeto, DDL e grants com a evidência da instalação anterior. |
| `PARTIAL_OR_DIFFERENT` para qualquer candidata ou sequência incompleta com uma migração posterior presente | Interrompa e revise o histórico da instalação. |
| `mapped_flags_enabled=0` | Pré-condição para uma instalação nova de `05c-01`. Se já houver uso comercial, preserve as autorizações e trate a instalação como alteração de um ambiente em operação. |

Registre as saídas, a data e os arquivos revisados. Combine uma janela sem tráfego comercial para a aplicação. Mantenha os gates de venda, CRM e recuperação fechados. A configuração do Render precisa de verificação pelo operador responsável.

## 02 · Migrações candidatas, em ordem

Cada fonte versionada tem sua própria transação. Execute um arquivo por vez com `ON_ERROR_STOP=1` e confira o resultado antes de aplicar o próximo. A lista abaixo usa os arquivos originais do repositório.

| Ordem | Arquivo | Condição |
| --- | --- | --- |
| 00 | [Baseline mapeado](../../../migrations/campaign-studio/05c-00-mapped-baseline.sql) | Para instalação limpa verificada em outro alvo autorizado. No PREVIEW com baseline verificado, preserve o já instalado. |
| 01 | [Autorização, auditoria e captura](../../../migrations/campaign-studio/05c-01-commercial-authorization.sql) | Aplique quando `05c-01` estiver `ABSENT`, com pré-requisitos e ausência de flags mapeadas confirmados. |
| 02 | [Autorização do efeito GHL](../../../migrations/campaign-studio/05c-02-commercial-ghl-effects.sql) | Aplique quando `05c-02` estiver `ABSENT`, após `05c-01` e com o RPC legado de checkpoint confirmado. |
| 03 | [Dependências e métricas](../../../migrations/campaign-studio/05c-03-commercial-metrics.sql) | Aplique quando `05c-03` estiver `ABSENT`, após `05c-02`. |

Para `PRESENT_VERIFY`, compare a versão instalada com a fonte candidata e confirme os resultados da etapa 03 antes de pular. `05a-commercial-install-preview.sql` é o registro do baseline histórico e fica fora desta sequência.

## 03 · Funções, permissões e guardas

Repita a etapa 01 e execute [03_VERIFICAR_FUNCOES_PREVIEW.sql](03_VERIFICAR_FUNCOES_PREVIEW.sql). Exija `PRESENT_VERIFY` nas três candidatas, `candidate_catalog=VERIFIED`, dois ledgers de autorização/auditoria com RLS e quatro triggers ativos. Confira os fingerprints dos corpos com a mesma revisão instalada no ambiente descartável. Preserve a evidência das permissões para `anon`, `authenticated` e `service_role`.

## 04 · Testes transacionais com dados sintéticos

A partir da raiz do checkout, com Node e a imagem `postgres:17-bookworm` já disponíveis localmente, execute:

```bash
bash qa/campaign-studio/preview/testar-sql-local.sh
```

O comando inicia um contêiner sem rede e sem porta publicada e se conecta ao PostgreSQL somente pelo socket Unix. Ele recria o esquema descartável em três bancos dedicados, aplica 00 a 03 e executa as suítes existentes de autorização, CRM, captura, reserva, Stripe, expiração, booking em revisão e métricas. Os testes transacionais usam `ROLLBACK`. A checagem de dependências deve indicar a autoria e parte dos RPCs legados de CRM ausentes na fixture. Esse resultado demonstra o bloqueio com dependências incompletas. O resultado do inventário do PREVIEW precisa confirmar todos esses RPCs reais.

Para validar o comportamento dos RPCs legados reais após autorização do responsável, prepare um clone descartável com o esquema do PREVIEW, sem dados de clientes, acesso de aplicações, segredos ou conectividade externa. Homologue autoria e atualização pelo RPC real, persistência das duas imagens, captura e deduplicação pelo nonce, claim e checkpoints reais do CRM e leitura das métricas. Use o roteiro das suítes locais como referência. A fixture do repositório inclui substitutos para RPCs legados. A confirmação do comportamento da instalação real depende da execução com o esquema do PREVIEW.

## 05 · Concorrência

O mesmo comando abre conexões PostgreSQL independentes para disputar uma autorização e um slot. Confira evidência de espera por lock, revisão obsoleta recusada, hold conflitante recusado e limpeza das fixtures. A prova entre o fluxo mapeado e o lock legado usa um escritor sintético. Os escritores reais de cada funil, o Vagaro e o Google Calendar exigem homologação externa própria.

## 06 · Verificação final

Execute [06_VERIFICACAO_FINAL_PREVIEW.sql](06_VERIFICACAO_FINAL_PREVIEW.sql) em leitura. `db_consistency=VERIFIED` confirma o vínculo das flags mapeadas e da captura com a autorização e confirma a linha de auditoria da revisão atual. Concilie as contagens de checkout, booking e CRM com o inventário inicial e explique trabalhos pendentes antes de seguir. O SQL atesta a consistência no banco. Liberação de fornecedores, ativação no Render e publicação de campanha são etapas operacionais posteriores.

## 07 · Rollback seguro

1. Feche `LLTOUCH_CM_COMMERCIAL_RELEASE_APPROVED` e os gates de novas reservas e checkout. Revogue ou pause a versão pelo painel. Pare novos efeitos de CRM sem perder o acompanhamento dos efeitos já assumidos.
2. Preserve o webhook e os workers de liquidação necessários para os lançamentos aceitos. Use a verificação final, os logs e os ledgers para conciliar efeitos, pagamentos e bookings. Mantenha snapshots e histórico de auditoria.
3. Para instalação candidata comprovadamente sem uso e sem trabalho em voo, revise as contagens sob manutenção e aplique o [rollback do 03](../../../migrations/campaign-studio/rollback/05c-03-commercial-metrics.sql), o [rollback do 02](../../../migrations/campaign-studio/rollback/05c-02-commercial-ghl-effects.sql) e o [rollback do 01](../../../migrations/campaign-studio/rollback/05c-01-commercial-authorization.sql), nessa ordem. O rollback do 01 recusa remoção se houver autorizações ou auditoria. Conserve o baseline do PREVIEW.
4. Em instalação com histórico, mantenha as estruturas persistentes e siga o rollback operacional dos passos 1 e 2. O [rollback do 00](../../../migrations/campaign-studio/rollback/05c-00-mapped-baseline.sql) é exclusivo para uma instalação nova e sem histórico do próprio 00. Rode o inventário e a verificação do baseline após a reversão.
