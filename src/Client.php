<?php

declare(strict_types=1);

namespace Kavox\Connect;

/**
 * Cliente da API de produtos do Kavox Connect (/v1). A documentação completa fica no próprio Connect, em /docs.
 *
 * - Autenticação: Authorization: Bearer kcx_test_… (sandbox) ou kcx_live_… (produção).
 * - Uma busca é uma integração e até 90 hotéis. Vários parceiros = várias chamadas, em paralelo (searchMany).
 * - Reserva leva Idempotency-Key: repetir com a mesma chave nunca reserva duas vezes.
 * - Listas paginam por cursor: {"...": [...], "next_cursor": "…"}; next_cursor ausente = última página.
 */
final class Client
{
    public const MAX_HOTELS = 90;

    private string $baseUrl;

    public function __construct(string $baseUrl, private readonly string $apiKey, private readonly int $timeout = 40)
    {
        $this->baseUrl = rtrim($baseUrl, '/');
        if ($this->baseUrl === '') {
            throw new \InvalidArgumentException('KAVOX_CONNECT_URL vazio');
        }
        if ($apiKey === '') {
            throw new \InvalidArgumentException('KAVOX_CONNECT_KEY vazio');
        }
    }

    public static function fromEnv(): self
    {
        $env = self::loadEnvFile(dirname(__DIR__) . '/.env');
        $url = getenv('KAVOX_CONNECT_URL') ?: ($env['KAVOX_CONNECT_URL'] ?? '');
        $key = getenv('KAVOX_CONNECT_KEY') ?: ($env['KAVOX_CONNECT_KEY'] ?? '');
        return new self($url, $key);
    }

    // --- chave e integrações

    /** A chave em uso: conta, ambiente e permissões. @return array<string, mixed> */
    public function me(): array
    {
        return $this->get('/v1/me');
    }

    /** Integrações que a chave pode usar, com credenciais e capacidades. @return array<string, mixed> */
    public function integrations(): array
    {
        return $this->get('/v1/integrations');
    }

    // --- conteúdo

    /**
     * Hotéis de uma região ou por nome (q, city_id, destination_id, country, lat+lng+radius_km, fields, cursor).
     *
     * @param array<string, scalar|null> $filter
     * @return array<string, mixed>
     */
    public function contentSearch(array $filter): array
    {
        return $this->get('/v1/content/hotels/search', $filter);
    }

    /**
     * Todos os ids de hotel de uma região, página a página, prontos para a busca de tarifa.
     *
     * @param array<string, scalar|null> $filter
     * @return list<string>
     */
    public function contentHotelIds(array $filter, int $max = 1000): array
    {
        $filter['fields'] = 'id';
        $ids = [];
        do {
            $page = $this->contentSearch($filter);
            array_push($ids, ...($page['hotel_ids'] ?? []));
            $filter['cursor'] = $page['next_cursor'] ?? null;
        } while ($filter['cursor'] !== null && count($ids) < $max);
        return array_slice($ids, 0, $max);
    }

    /** Ficha de um hotel (fields: basic, images, texts, facts...). @return array<string, mixed> */
    public function contentHotel(string $hotelId, ?string $fields = null, ?string $language = null): array
    {
        return $this->get('/v1/content/hotels/' . rawurlencode($hotelId), ['fields' => $fields, 'language' => $language]);
    }

    /** Destinos por nome, para o autocomplete. @return array<string, mixed> */
    public function destinations(string $q): array
    {
        return $this->get('/v1/content/destinations', ['q' => $q]);
    }

    // --- hotel

    /**
     * Busca de tarifas numa integração. $hotels identifica os hotéis de um dos três jeitos:
     * ['hotel_ids' => [...]], ['giata_hotel_ids' => [...]] ou ['supplier_hotel_ids' => [...]].
     *
     * @param array<string, list<string|int>> $hotels
     * @param list<array{adults: int, children_ages?: list<int>}> $rooms
     * @param array<string, mixed> $options credential, currency, guest_country, max_rates_per_hotel
     * @return array<string, mixed>
     */
    public function search(string $integration, array $hotels, string $checkIn, string $checkOut, array $rooms, array $options = []): array
    {
        return $this->post('/v1/hotels/search', $this->searchBody($integration, $hotels, $checkIn, $checkOut, $rooms, $options));
    }

    /**
     * Várias buscas ao mesmo tempo: uma por integração e por lote de até 90 hotéis. O Connect não espalha
     * a busca; quem consome paraleliza. Uma busca que falha não derruba as outras: vem em "error".
     *
     * @param list<string> $integrations
     * @param array<string, list<string|int>> $hotels
     * @param list<array{adults: int, children_ages?: list<int>}> $rooms
     * @param array<string, mixed> $options
     * @return list<array{integration: string, response?: array<string, mixed>, error?: ApiException}>
     */
    public function searchMany(array $integrations, array $hotels, string $checkIn, string $checkOut, array $rooms, array $options = []): array
    {
        $kind = array_key_first($hotels);
        $calls = [];
        foreach ($integrations as $integration) {
            foreach (array_chunk($hotels[$kind] ?? [], self::MAX_HOTELS) as $chunk) {
                $calls[] = [$integration, $this->searchBody($integration, [$kind => $chunk], $checkIn, $checkOut, $rooms, $options)];
            }
        }
        $multi = curl_multi_init();
        $handles = [];
        foreach ($calls as $i => [, $body]) {
            $handles[$i] = $this->handle('POST', '/v1/hotels/search', [], $body);
            curl_multi_add_handle($multi, $handles[$i]);
        }
        do {
            $status = curl_multi_exec($multi, $running);
            if ($running) {
                curl_multi_select($multi);
            }
        } while ($running && $status === CURLM_OK);

        $out = [];
        foreach ($calls as $i => [$integration]) {
            $raw = curl_multi_getcontent($handles[$i]);
            try {
                $out[] = ['integration' => $integration, 'response' => $this->decode($handles[$i], $raw, 'POST', '/v1/hotels/search')];
            } catch (ApiException $e) {
                $out[] = ['integration' => $integration, 'error' => $e];
            }
            curl_multi_remove_handle($multi, $handles[$i]);
        }
        curl_multi_close($multi);
        return $out;
    }

    /** Confirma preço e condições de uma tarifa da busca. @return array<string, mixed> */
    public function quote(string $rateToken): array
    {
        return $this->post('/v1/hotels/quote', ['rate_token' => $rateToken]);
    }

    /**
     * Reserva a oferta de uma cotação. Guarde a $idempotencyKey: repetir com ela, depois de um timeout,
     * devolve a mesma reserva em vez de reservar de novo.
     *
     * @param array<string, mixed> $booking offer_token, holder, rooms[].guests, reference...
     * @return array<string, mixed>
     */
    public function book(array $booking, string $idempotencyKey): array
    {
        return $this->post('/v1/hotels/bookings', $booking, $idempotencyKey);
    }

    /** @return array<string, mixed> */
    public function booking(string $bookingId): array
    {
        return $this->get('/v1/hotels/bookings/' . rawurlencode($bookingId));
    }

    /** @param array<string, mixed> $body ex.: ['max_penalty' => ['amount' => '0.00', 'currency' => 'BRL']] @return array<string, mixed> */
    public function cancel(string $bookingId, array $body = []): array
    {
        return $this->post('/v1/hotels/bookings/' . rawurlencode($bookingId) . '/cancel', $body);
    }

    public static function uuid(): string
    {
        $b = random_bytes(16);
        $b[6] = chr((ord($b[6]) & 0x0f) | 0x40);
        $b[8] = chr((ord($b[8]) & 0x3f) | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($b), 4));
    }

    // --- HTTP

    /** @param array<string, scalar|null> $query @return array<string, mixed> */
    public function get(string $path, array $query = []): array
    {
        return $this->request('GET', $path, $query);
    }

    /** @param array<string, mixed> $body @return array<string, mixed> */
    public function post(string $path, array $body, ?string $idempotencyKey = null): array
    {
        return $this->request('POST', $path, [], $body, $idempotencyKey);
    }

    /**
     * @param array<string, list<string|int>> $hotels
     * @param list<array<string, mixed>> $rooms
     * @param array<string, mixed> $options
     * @return array<string, mixed>
     */
    private function searchBody(string $integration, array $hotels, string $checkIn, string $checkOut, array $rooms, array $options): array
    {
        $kinds = array_intersect_key($hotels, array_flip(['hotel_ids', 'giata_hotel_ids', 'supplier_hotel_ids']));
        if (count($kinds) !== 1 || count($hotels) !== 1) {
            throw new \InvalidArgumentException('informe só um entre hotel_ids, giata_hotel_ids e supplier_hotel_ids');
        }
        return ['integration' => $integration] + $kinds + ['check_in' => $checkIn, 'check_out' => $checkOut, 'rooms' => $rooms]
            + array_filter($options, static fn ($v) => $v !== null && $v !== '');
    }

    /**
     * @param array<string, scalar|null> $query
     * @param array<string, mixed>|null $body
     * @return array<string, mixed>
     */
    private function request(string $method, string $path, array $query = [], ?array $body = null, ?string $idempotencyKey = null): array
    {
        $ch = $this->handle($method, $path, $query, $body, $idempotencyKey);
        $raw = curl_exec($ch);
        if ($raw === false) {
            throw new \RuntimeException("falha de rede em {$method} {$path}: " . curl_error($ch));
        }
        return $this->decode($ch, (string) $raw, $method, $path);
    }

    /**
     * @param array<string, scalar|null> $query
     * @param array<string, mixed>|null $body
     */
    private function handle(string $method, string $path, array $query = [], ?array $body = null, ?string $idempotencyKey = null): \CurlHandle
    {
        $query = array_filter($query, static fn ($v) => $v !== null && $v !== '');
        $url = $this->baseUrl . $path . ($query ? '?' . http_build_query($query) : '');
        $headers = ['Authorization: Bearer ' . $this->apiKey, 'Accept: application/json', 'Accept-Language: pt-BR'];
        if ($body !== null) {
            $headers[] = 'Content-Type: application/json';
        }
        if ($idempotencyKey !== null) {
            $headers[] = 'Idempotency-Key: ' . $idempotencyKey;
        }
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_TIMEOUT => $this->timeout,
            CURLOPT_ENCODING => '', // aceita gzip
            CURLOPT_POSTFIELDS => $body !== null ? json_encode($body, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE) : null,
        ]);
        return $ch;
    }

    /** @return array<string, mixed> */
    private function decode(\CurlHandle $ch, ?string $raw, string $method, string $path): array
    {
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        if ($status === 0) {
            throw new \RuntimeException("falha de rede em {$method} {$path}: " . curl_error($ch));
        }
        $data = ($raw === null || $raw === '') ? [] : json_decode($raw, true);
        if ($status >= 400) {
            $e = is_array($data) ? (array) ($data['error'] ?? []) : [];
            throw new ApiException(
                $status,
                (string) ($e['code'] ?? 'HTTP_' . $status),
                (string) ($e['message'] ?? 'erro'),
                (bool) ($e['retryable'] ?? false),
                (array) ($e['details'] ?? []),
                $e['request_id'] ?? null,
                $e['integration'] ?? null,
                $e['supplier_code'] ?? null,
                $e['supplier_message'] ?? null,
                $e,
            );
        }
        return is_array($data) ? $data : [];
    }

    /** @return array<string, string> */
    private static function loadEnvFile(string $file): array
    {
        if (!is_file($file)) {
            return [];
        }
        $out = [];
        foreach (file($file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [] as $line) {
            if (str_starts_with(trim($line), '#') || !str_contains($line, '=')) {
                continue;
            }
            [$k, $v] = explode('=', $line, 2);
            $out[trim($k)] = trim(trim($v), '"\'');
        }
        return $out;
    }
}
