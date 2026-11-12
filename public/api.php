<?php

declare(strict_types=1);

// Ponte entre a tela (public/index.html) e o Kavox Connect. As chaves ficam aqui no servidor, nunca no
// navegador: a tela manda método, caminho e corpo; esta ponte escolhe a chave pelo caminho (/v1/management
// usa a de gestão, o resto a de produto), chama o Connect e devolve a resposta como veio, com status e tempo.
//
// ?action=config  GET: endereço e começo das chaves em uso · POST: troca-os nesta sessão do navegador
// ?action=call    POST {method, path, query, body, headers}

require dirname(__DIR__) . '/src/autoload.php';

use Kavox\Connect\Client;

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

$env = Client::env();
guard($env['KAVOX_SDK_PASSWORD'] ?? '');
session_start();

$action = $_GET['action'] ?? '';
$input = json_decode((string) file_get_contents('php://input'), true) ?: [];

try {
    match ($action) {
        'config' => config($env, $input),
        'call' => call($env, $input),
        default => reply(404, ['error' => 'ação desconhecida']),
    };
} catch (Throwable $e) {
    reply(500, ['error' => $e->getMessage()]);
}

/** Com KAVOX_SDK_PASSWORD definido, a tela pede usuário e senha (qualquer usuário). Use num servidor exposto. */
function guard(string $password): void
{
    if ($password === '' || hash_equals($password, (string) ($_SERVER['PHP_AUTH_PW'] ?? ''))) {
        return;
    }
    header('WWW-Authenticate: Basic realm="Kavox Connect SDK"');
    reply(401, ['error' => 'senha']);
}

/** @param array<string, string> $env */
function setting(array $env, string $name): string
{
    return (string) ($_SESSION[$name] ?? $env[$name] ?? '');
}

/** @param array<string, string> $env @param array<string, mixed> $input */
function config(array $env, array $input): void
{
    if ($_SERVER['REQUEST_METHOD'] === 'POST') {
        if (!empty($input['reset'])) {
            unset($_SESSION['KAVOX_CONNECT_URL'], $_SESSION['KAVOX_CONNECT_KEY'], $_SESSION['KAVOX_CONNECT_MGMT_KEY']);
        }
        foreach (['url' => 'KAVOX_CONNECT_URL', 'product_key' => 'KAVOX_CONNECT_KEY', 'mgmt_key' => 'KAVOX_CONNECT_MGMT_KEY'] as $field => $name) {
            $value = trim((string) ($input[$field] ?? ''));
            if ($value !== '') {
                $_SESSION[$name] = $value; // campo vazio mantém o atual
            }
        }
    }
    $mask = static fn (string $key): ?string => $key === '' ? null : substr($key, 0, 13) . '…';
    reply(200, [
        'url' => setting($env, 'KAVOX_CONNECT_URL'),
        'product_key' => $mask(setting($env, 'KAVOX_CONNECT_KEY')),
        'mgmt_key' => $mask(setting($env, 'KAVOX_CONNECT_MGMT_KEY')),
        'overridden' => isset($_SESSION['KAVOX_CONNECT_URL']) || isset($_SESSION['KAVOX_CONNECT_KEY']) || isset($_SESSION['KAVOX_CONNECT_MGMT_KEY']),
    ]);
}

/** @param array<string, string> $env @param array<string, mixed> $input */
function call(array $env, array $input): void
{
    $method = strtoupper((string) ($input['method'] ?? 'GET'));
    $path = (string) ($input['path'] ?? '');
    if (!in_array($method, ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], true) || !preg_match('#^/v1(/[A-Za-z0-9._~%-]+)*/?$#', $path)) {
        reply(400, ['error' => 'método ou caminho inválido']);
    }
    $management = str_starts_with($path, '/v1/management');
    $key = setting($env, $management ? 'KAVOX_CONNECT_MGMT_KEY' : 'KAVOX_CONNECT_KEY');
    $url = setting($env, 'KAVOX_CONNECT_URL');
    if ($url === '' || $key === '') {
        reply(200, ['status' => 0, 'duration_ms' => 0, 'body' => null,
            'error' => $management ? 'sem chave de gestão (KAVOX_CONNECT_MGMT_KEY): configure em Configuração' : 'sem chave de produto (KAVOX_CONNECT_KEY): configure em Configuração']);
    }

    $headers = [];
    foreach ((array) ($input['headers'] ?? []) as $name => $value) {
        if (in_array($name, ['Idempotency-Key', 'X-Mock-Scenario', 'Accept-Language', 'If-None-Match'], true) && is_string($value) && $value !== '') {
            $headers[$name] = $value;
        }
    }
    $query = array_filter((array) ($input['query'] ?? []), static fn ($v) => is_scalar($v) && $v !== '');
    $body = array_key_exists('body', $input) && $input['body'] !== null ? (array) $input['body'] : null;

    $client = new Client($url, $key);
    $res = $client->send($method, $path, $query, $body, $headers);
    $res['request'] = [
        'method' => $method,
        'url' => $client->baseUrl() . $path . ($query ? '?' . http_build_query($query) : ''),
        'key' => $client->keyPrefix(),
        'headers' => $headers,
        'body' => $body,
    ];
    reply(200, $res);
}

/** @param array<string, mixed> $data */
function reply(int $status, array $data): never
{
    http_response_code($status);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}
