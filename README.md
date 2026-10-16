# Jungle Gaming — Distributed Wagering Processor

Solução para o [desafio backend da Jungle Gaming](https://github.com/junglegaming/backend-challenge).
NestJS, Bun 1.4.3, TypeScript estrito, PostgreSQL 16, MikroORM e SQS/LocalStack.

O serviço processa BET, WIN, LOSS, REFUND e ROLLBACK. O banco confirma juntos a
operação, o saldo, o ledger, as partidas dobradas, a inbox e a outbox.

## O que está implementado

| Requisito                           | Solução e evidência                                                          |
| ----------------------------------- | ---------------------------------------------------------------------------- |
| Dinheiro exato e saldo não negativo | Decimal.js, strings decimais, NUMERIC e constraints no PostgreSQL            |
| Concorrência entre instâncias       | Lock por carteira; teste com três processos e 50 cópias da mesma aposta      |
| Idempotência persistente            | Chave, hash canônico e resposta histórica gravados no banco                  |
| Histórico e reversões               | Ledger imutável, referências validadas e reconciliação sem reparo silencioso |
| Mensageria e recuperação            | Inbox/outbox transacionais, ACK após commit, retry, DLQ e testes de queda    |
| HTTP e operação local               | NestJS, health checks, Docker Compose e migrations reversíveis               |
| Observabilidade                     | Logs JSON, métricas Prometheus, OpenTelemetry, Grafana e Jaeger              |
| Diferenciais opcionais              | Partidas dobradas e experimento de carga com resultados publicados           |

A verificação local executou **86 testes com PostgreSQL e LocalStack, sem falhas**.
Os limites e decisões técnicas estão explicados em
[ARCHITECTURE.md](ARCHITECTURE.md#autenticação-e-operação-local). Os resultados do
experimento de carga estão em [LOAD-TEST.md](LOAD-TEST.md). A avaliação final cabe à empresa.

## Iniciar com Docker

Requisitos: Docker Engine e Docker Compose v2. Portas locais: 3000, 5433 e 4566.

```sh
git clone https://github.com/pegruk/jungle-gaming-wagering-processor.git
cd jungle-gaming-wagering-processor
docker compose up -d --build --wait
curl http://localhost:3000/health/ready
docker compose exec app bun scripts/demo.ts
```

As migrations são executadas na inicialização, com lock entre instâncias.
As quatro filas são criadas pelo hook do LocalStack. O schema da aplicação é
`wagering`: tabelas de experimentos antigos no schema `public` são preservadas.
As migrations recusam históricos incompatíveis; não inventam lançamentos nem
apagam dados financeiros para conseguir concluir.

```sh
docker compose logs -f app
docker compose stop
```

`stop` preserva o volume PostgreSQL. A reinicialização retoma os eventos ainda
não publicados. LocalStack usa armazenamento local efêmero: se o container for
recriado, mensagens já entregues ao broker podem desaparecer. Para simular queda
da **aplicação**, reinicie somente `app`.

## Executar no host e testar

Requisito adicional: Bun 1.4.3. As dependências são fixadas em `bun.lock`.

```sh
bun install --frozen-lockfile
docker compose up -d --wait postgres localstack
cp .env.example .env
bun run db:migrate
bun run start
```

Ao executar a aplicação no host, mantenha o serviço `app` do Compose parado para
liberar a porta 3000. `.env` é carregado pelo Bun; não deve ser commitado.

```sh
bun run typecheck
bun run build
bun run lint
bun run format:check
bun test
```

Os testes de integração usam PostgreSQL e LocalStack reais. Cada suíte cria seu
próprio schema e suas próprias filas, removidos ao terminar. Não exigem que a
aplicação esteja em execução: os testes HTTP iniciam servidores temporários.
Uma indisponibilidade da infraestrutura produz falha explícita, sem pular testes.

Comandos específicos: `test:unit`, `test:integration`, `test:concurrency` e `test:e2e`.
O teste de concorrência inicia três processos NestJS. Outro mata um processo com
SIGKILL depois do commit e antes do ack, aguardando a entrega para outro worker.

`bun run db:rollback` desfaz **uma** migration, em ordem inversa. Use em ambiente
descartável: desfazer migrations que removem tabelas destrói seus dados. O ciclo
completo de up/down é testado em schemas temporários.

## Exemplo HTTP

```sh
curl -i -X POST http://localhost:3000/wallets \
  -H 'Content-Type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"100.00","currency":"BRL"}}'
```

Copie o `id` retornado para `walletId`:

```sh
curl -i -X POST http://localhost:3000/wagering/transactions \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: provider-a:bet-1' \
  -H 'X-Correlation-Id: demonstration-1' \
  -d '{"providerId":"provider-a","externalTransactionId":"bet-1","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"SUBSTITUIR-PELO-ID","roundId":"round-1","gameId":"game-1","kind":"BET","money":{"amount":"80.00","currency":"BRL"}}'
```

Repita com a mesma chave e corpo: o resultado mantém o saldo observado na operação
original e retorna `idempotentReplay: true`. Mudar o corpo mantendo a chave retorna 409. Usar outra chave para o mesmo ID externo também retorna 409.

Valores monetários são strings com duas casas. `number`, sinais negativos, NaN,
Infinity, notação científica e arredondamento de entradas são recusados.

| Endpoint                                                       | Função                                                    |
| -------------------------------------------------------------- | --------------------------------------------------------- |
| `POST /wallets`                                                | Cria carteira e OPENING quando o saldo inicial é positivo |
| `GET /wallets/:id`                                             | Saldo e versão                                            |
| `GET /wallets/:id/ledger?limit=50&cursor=...`                  | Histórico com cursor opaco assinado                       |
| `POST /wagering/transactions`                                  | Processa uma operação; header obrigatório                 |
| `GET /wagering/transactions/:id`                               | Operação, estado e resultado histórico                    |
| `GET /providers/:providerId/wagering/transactions/:externalId` | Consulta pelo ID do provedor                              |
| `POST /wallets/:id/reconciliation`                             | Compara saldo armazenado com o ledger                     |
| `GET /health/live`                                             | Processo vivo                                             |
| `GET /health/ready`                                            | Banco e filas alcançáveis                                 |
| `GET /metrics`                                                 | Métricas Prometheus                                       |

Submissão: 200 processada/replay, 202 referência pendente, 400 entrada inválida,
404 carteira inexistente, 409 conflito, 422 rejeição de negócio e 503 falha
transitória reconhecida de infraestrutura. Erros inesperados retornam 500.
Uma rejeição possui `failureCode` estável. O cliente repete falhas transitórias
com a **mesma chave**, sem criar uma nova aposta.

## SQS

Entrada: `wager-transactions.fifo`; falhas: `wager-transactions-dlq.fifo`.
Saída: `wager-events.fifo`; falhas: `wager-events-dlq.fifo`.

```json
{
  "messageId": "message-1",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-10-16T00:00:00.000Z",
  "data": {
    "providerId": "provider-a",
    "externalTransactionId": "bet-1",
    "idempotencyKey": "provider-a:bet-1",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "SUBSTITUIR-PELO-ID",
    "roundId": "round-1",
    "gameId": "game-1",
    "kind": "BET",
    "money": { "amount": "80.00", "currency": "BRL" }
  }
}
```

Publique com `MessageGroupId=walletId` e um `MessageDeduplicationId` por envio.
A proteção final está no PostgreSQL, inclusive fora da janela de deduplicação FIFO.
O consumidor de eventos incluído registra cada eventId uma vez em `event_receipts`.

## Bônus: observabilidade e carga

```sh
OTEL_ENABLED=true docker compose --profile observability up -d --build --wait
```

- Grafana: http://localhost:3001/d/wagering — painel provisionado, leitura anônima local.
- Prometheus: http://localhost:9090 — dados de `/metrics` a cada cinco segundos.
- Jaeger: http://localhost:16686 — selecione `wagering-processor` após criar carteiras/apostas.
- Partidas dobradas: `journal_postings`; cada transação financeira tem dois registros
  de mesmo valor e sentidos contrários, verificados no commit.

```sh
bun run test:load
LOAD_MODE=hot LOAD_CONCURRENCY=4 LOAD_DURATION_SECONDS=10 bun run test:load
bun run verify:observability
```

O experimento cria carteiras próprias, aquece o endpoint e mede HTTP com 20% de
repetições a partir do sexto pedido de cada trabalhador. Relata ambiente,
throughput, p50/p95/p99, erros, conflitos de lock, atraso da outbox e reconciliação
final. Resultados brutos ficam em `reports/`; a análise está em [LOAD-TEST.md](LOAD-TEST.md).
É um experimento local curto, sem promessa de capacidade em produção.

## Decisões e evidências

- [ARCHITECTURE.md](ARCHITECTURE.md): transações, locks, falhas, códigos e limites.
- [LOAD-TEST.md](LOAD-TEST.md): metodologia, resultados e limites do experimento de carga.

Autenticação externa foi deixada como extensão explícita em `ProviderIdentityGuard`,
conforme a opção permitida pelo desafio. O serviço local confia no providerId
declarado; não deve ser exposto como uma API financeira pública sem essa integração.
