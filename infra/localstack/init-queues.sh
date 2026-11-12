#!/bin/sh
# Cria as filas do desafio. Idempotente: create-queue com os mesmos atributos nao falha.
set -eu

awslocal sqs create-queue --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true

DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --queue-url "$(awslocal sqs get-queue-url --queue-name wager-transactions-dlq.fifo --query QueueUrl --output text)" \
  --attribute-names QueueArn --query Attributes.QueueArn --output text)

awslocal sqs create-queue --queue-name wager-events.fifo \
  --attributes FifoQueue=true

# Por ultimo: o healthcheck do compose espera por esta fila.
awslocal sqs create-queue --queue-name wager-transactions.fifo \
  --attributes "{\"FifoQueue\":\"true\",\"VisibilityTimeout\":\"30\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"$DLQ_ARN\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"}"
