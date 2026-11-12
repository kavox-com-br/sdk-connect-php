<?php

declare(strict_types=1);

namespace Kavox\Connect;

/**
 * Erro da API no envelope padrão: {"error": {"code", "category", "message", "retryable", "request_id", ...}}.
 * O request_id é o que o suporte pede. supplierCode/supplierMessage são do parceiro, sem tradução: para log.
 */
final class ApiException extends \RuntimeException
{
    /**
     * @param array<int, array{field: string, code: string}> $details
     * @param array<string, mixed> $raw o objeto "error" inteiro (ex.: "offer" num PRICE_CHANGED)
     */
    public function __construct(
        public readonly int $status,
        public readonly string $errorCode,
        string $message,
        public readonly bool $retryable = false,
        public readonly array $details = [],
        public readonly ?string $requestId = null,
        public readonly ?string $integration = null,
        public readonly ?string $supplierCode = null,
        public readonly ?string $supplierMessage = null,
        public readonly array $raw = [],
    ) {
        parent::__construct(sprintf('%d %s: %s (request_id %s)', $status, $errorCode, $message, $requestId ?? '-'), $status);
    }
}
