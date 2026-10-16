#!/bin/bash
# scripts/init-sqs.sh
echo "Inicializando filas AWS SQS FIFO no LocalStack..."
# 1. Cria a Dead Letter Queue (DLQ)
awslocal sqs create-queue \
	--queue-name wagering-dlq.fifo \
	--attributes "{\"FifoQueue\": \"true\", \"ContentBasedDeduplication\": \"false\"}"
DLQ_URL=$(awslocal sqs get-queue-url --queue-name wagering-dlq.fifo --query 'QueueUrl' --output text)
DLQ_ARN=$(awslocal sqs get-queue-attributes \
	--queue-url "$DLQ_URL" \
	--attribute-names QueueArn --query 'Attributes.QueueArn' --output text)
# 2. Cria a Fila Principal com Redrive Policy (maxReceiveCount = 3)
awslocal sqs create-queue \
	--queue-name wagering-events.fifo \
	--attributes "{\"FifoQueue\": \"true\", \"ContentBasedDeduplication\": \"false\", \"RedrivePolicy\": \"{\\\"deadLetterTargetArn\\\": \\\"$DLQ_ARN\\\", \\\"maxReceiveCount\\\": \\\"3\\\"}\"}"
echo "Filas SQS FIFO criadas com sucesso!"
