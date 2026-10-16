#!/bin/bash
set -euo pipefail

for name in wager-transactions wager-events; do
  awslocal sqs create-queue --queue-name "$name-dlq.fifo" \
    --attributes FifoQueue=true,ContentBasedDeduplication=false >/dev/null
  dlq_url=$(awslocal sqs get-queue-url --queue-name "$name-dlq.fifo" --query QueueUrl --output text)
  arn=$(awslocal sqs get-queue-attributes --queue-url "$dlq_url" --attribute-names QueueArn --query Attributes.QueueArn --output text)
  attributes=$(python -c 'import json,sys; print(json.dumps({"FifoQueue":"true","ContentBasedDeduplication":"false","RedrivePolicy":json.dumps({"deadLetterTargetArn":sys.argv[1],"maxReceiveCount":"3"})}))' "$arn")
  awslocal sqs create-queue --queue-name "$name.fifo" --attributes "$attributes" >/dev/null
done
echo 'SQS input, events and dead-letter queues ready'
