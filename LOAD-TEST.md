# Experimento de carga

## Ambiente e método

Medições em 16/10/2026. Bun 1.4.3; Linux 7.2.9-arch1-1; AMD A4-7300,
dois processadores lógicos e 6,95 GiB de RAM. Aplicação, PostgreSQL 16, LocalStack 4,
Prometheus, Grafana, Jaeger e gerador no mesmo computador. Uma instância da API,
com OpenTelemetry ativo, quatro consumidores de entrada e dois publishers.

As execuções principais duram 30 s, com quatro requisições concorrentes e dez
requisições de aquecimento fora da amostra. Cada aposta tem valor exato de
`0.01 BRL`. A cada cinco pedidos por trabalhador, a partir do sexto, o gerador
repete o corpo e a chave anteriores. O percentual efetivo de replay é registrado.

Dois cenários: dez carteiras distintas e uma única carteira compartilhada.
O gerador é de circuito fechado: cada trabalhador espera sua resposta antes do
pedido seguinte. O throughput inclui replays. A latência é medida no cliente,
incluindo rede e leitura da resposta, em milissegundos.

Ao terminar, o gerador observa o escoamento da outbox por até 30 s e reconcilia
todas as carteiras do experimento. Uma amostra de métricas por segundo registra
o maior backlog/lag observado; picos entre amostras podem não aparecer.
“Conflitos” representa timeout/deadlock/erro de serialização, não espera normal
por uma carteira ocupada. Zero conflitos não significa ausência de espera.

## Versão final, com publicação em lotes

Comandos:

```sh
OTEL_ENABLED=true docker compose --profile observability up -d --build --wait
OTEL_ENABLED=true LOAD_DURATION_SECONDS=30 bun run test:load
OTEL_ENABLED=true LOAD_MODE=hot LOAD_DURATION_SECONDS=30 bun run test:load
```

| Medida                              | Dez carteiras | Uma carteira |
| ----------------------------------- | ------------: | -----------: |
| Requisições                         |         1.042 |          486 |
| Replays                             |           207 |           94 |
| Requisições/s                       |         34,66 |        16,07 |
| p50                                 |     108,97 ms |    202,25 ms |
| p95                                 |     224,38 ms |    623,43 ms |
| p99                                 |     294,23 ms |  1.065,78 ms |
| Erros                               |             0 |            0 |
| Timeouts/deadlocks/serialização     |             0 |            0 |
| Maior quantidade pendente observada |            10 |            6 |
| Maior lag observado                 |       0,377 s |      0,970 s |
| Pendências após escoamento          |             0 |            0 |
| Espera após a amostra para escoar   |       0,252 s |      0,253 s |
| Reconciliação de todas as carteiras |   Consistente |  Consistente |

Resultados brutos:

- [Dez carteiras — 30 s](reports/load-distributed-2026-10-16T03-32-28.828Z.json)
- [Uma carteira — 30 s](reports/load-hot-2026-10-16T03-36-04.931Z.json)

O código de publicação medido corresponde a `36a037f`; o commit seguinte acrescenta
testes. O script guarda runtime, hardware, parâmetros, duração real, erros e
estatísticas completas. Nenhuma requisição não 2xx foi descartada da taxa de erros.

## Gargalo encontrado e melhoria

A medição anterior, com um evento por chamada SQS, produziu 1.010 requisições em
30 s, 33,57 req/s e zero erros. Porém terminou com 947 eventos pendentes, lag de
19,36 s e levou mais 24,47 s para escoar. Todas as carteiras continuaram corretas.

Foi adotado o envio nativo em lotes de até dez mensagens. A outbox continua
bloqueada por transação SQL e cada entrada só é marcada publicada quando seu ID
aparece entre as confirmações do SQS. Falhas parciais recebem backoff individual.
Os testes de concorrência, confirmação parcial e morte após envio foram preservados.

Na execução final com dez carteiras, o backlog máximo observado caiu para dez,
com escoamento em aproximadamente 0,25 s após o término. O throughput da API ficou
na mesma ordem de grandeza. A comparação indica melhora na publicação; uma única
execução por versão não permite atribuir significado estatístico ao pequeno aumento
de throughput.

- [Medição anterior — 30 s](reports/load-distributed-2026-10-16T03-21-46.892Z.json)
- Pilotos de 10 s também foram preservados em `reports/`; não são misturados nas
  estatísticas da tabela final. Nos pilotos, o campo de espera incluía também a
  reconciliação; as medições de 30 s isolam a espera de publicação.

## Interpretação e limites

Uma carteira compartilhada serializa mudanças de saldo. A checagem contábil no
commit relê seu histórico, e o custo cresce com o número de operações. A diferença
entre os cenários é compatível com essa disputa e esse custo; não foi feito um
perfil detalhado para separar CPU, I/O, espera de lock e overhead das ferramentas.

Este é um diagnóstico local curto com hardware compartilhado, sem gerador externo,
sem repetições estatísticas e sem validação de longas durações ou grandes históricos.
Ele não estabelece um limite de capacidade de produção. A evidência principal é:
nessas execuções não houve erro financeiro, as repetições foram reconhecidas e o
trabalho de publicação terminou sem pendências observadas.

Antes de dimensionar produção, seriam necessários testes de duração maior,
históricos extensos por wallet, variação de concorrência e instâncias, isolamento
do gerador e medições por componente. Nenhuma meta de RPS foi inventada para o desafio.
