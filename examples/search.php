<?php

declare(strict_types=1);

// Busca de tarifas de hotel pela linha de comando.
//
//   php examples/search.php --q=Copacabana                       # hotéis por nome, no mock
//   php examples/search.php --destination=Gramado --integration=expedia,hotelbeds
//   php examples/search.php --giata=10746,31207 --checkin=2027-01-10 --nights=3 --adults=2,1
//   php examples/search.php --hotels=<uuid>,<uuid> --children=7 --quote
//
// Hotéis: --q (nome), --destination (nome do destino), --city (city_id), --hotels (hotel_id do catálogo),
// --giata (id do GIATA) ou --codes (código do parceiro). Padrão: mock, daqui a 30 dias, 2 noites, 2 adultos.

require dirname(__DIR__) . '/src/autoload.php';

use Kavox\Connect\ApiException;
use Kavox\Connect\Client;

$opt = getopt('', ['q:', 'destination:', 'city:', 'hotels:', 'giata:', 'codes:', 'integration:', 'checkin:', 'nights:',
    'adults:', 'children:', 'currency:', 'country:', 'max:', 'rates:', 'quote', 'json']);
$list = static fn (string $name): array => array_values(array_filter(array_map('trim', explode(',', (string) ($opt[$name] ?? '')))));

try {
    $api = Client::fromEnv();
    $max = (int) ($opt['max'] ?? 90);

    // 1. os hotéis
    $hotels = match (true) {
        isset($opt['hotels']) => ['hotel_ids' => $list('hotels')],
        isset($opt['giata']) => ['giata_hotel_ids' => array_map('intval', $list('giata'))],
        isset($opt['codes']) => ['supplier_hotel_ids' => $list('codes')],
        isset($opt['city']) => ['hotel_ids' => $api->contentHotelIds(['city_id' => $opt['city']], $max)],
        isset($opt['destination']) => ['hotel_ids' => $api->contentHotelIds(firstDestination($api, $opt['destination']), $max)],
        isset($opt['q']) => ['hotel_ids' => $api->contentHotelIds(['q' => $opt['q']], $max)],
        default => throw new InvalidArgumentException('informe --q, --destination, --city, --hotels, --giata ou --codes'),
    };
    $count = count(reset($hotels));
    if ($count === 0) {
        fwrite(STDERR, "nenhum hotel encontrado no catálogo\n");
        exit(1);
    }

    // 2. a estadia
    $checkIn = new DateTimeImmutable($opt['checkin'] ?? '+30 days');
    $checkOut = $checkIn->modify('+' . max(1, (int) ($opt['nights'] ?? 2)) . ' days');
    $children = array_map('intval', $list('children'));
    $rooms = [];
    foreach ($list('adults') ?: ['2'] as $i => $adults) {
        $room = ['adults' => (int) $adults];
        if ($i === 0 && $children) {
            $room['children_ages'] = $children;
        }
        $rooms[] = $room;
    }
    $integrations = $list('integration') ?: ['mock'];
    $options = ['currency' => $opt['currency'] ?? null, 'guest_country' => $opt['country'] ?? null,
        'max_rates_per_hotel' => (int) ($opt['rates'] ?? 3)];

    printf(isset($opt['json']) ? '' : "%d hotéis · %s a %s · %d quarto(s) · %s\n\n", $count, $checkIn->format('Y-m-d'), $checkOut->format('Y-m-d'),
        count($rooms), implode(', ', $integrations));

    // 3. uma busca por integração e por lote de 90, todas ao mesmo tempo
    $started = microtime(true);
    $answers = $api->searchMany($integrations, $hotels, $checkIn->format('Y-m-d'), $checkOut->format('Y-m-d'), $rooms, $options);
    $took = (int) round((microtime(true) - $started) * 1000);

    if (isset($opt['json'])) {
        echo json_encode(array_map(static fn ($a) => isset($a['error'])
            ? ['integration' => $a['integration'], 'error' => $a['error']->raw]
            : $a, $answers), JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), PHP_EOL;
        exit(0);
    }

    $first = null;
    foreach ($answers as $a) {
        if (isset($a['error'])) {
            printf("[%s] ERRO %s\n\n", $a['integration'], $a['error']->getMessage());
            continue;
        }
        $r = $a['response'];
        printf("[%s] credencial %s · %d hotéis com tarifa · %d ms\n", $r['integration'], $r['credential'], count($r['results']), $r['duration_ms']);
        foreach ($r['warnings'] ?? [] as $w) {
            $ids = $w['hotel_ids'] ?? $w['giata_hotel_ids'] ?? $w['supplier_hotel_ids'] ?? [];
            printf("  aviso %s%s\n", $w['code'], $ids ? ' (' . count($ids) . ': ' . implode(', ', array_slice($ids, 0, 3)) . (count($ids) > 3 ? ', …' : '') . ')' : '');
        }
        foreach ($r['results'] as $h) {
            $label = isset($h['giata_hotel_id']) ? 'giata ' . $h['giata_hotel_id'] : ($h['hotel_id'] ?? 'código ' . $h['supplier_hotel_id']);
            printf("  %s\n", $label);
            foreach ($h['rates'] as $rate) {
                $first ??= $rate;
                printf("    %12s %s  %-12s %-14s %s\n", $rate['net']['amount'], $rate['net']['currency'], $rate['board'],
                    ($rate['cancellation_policy']['refundable'] ?? false) ? 'reembolsável' : 'não reemb.', $rate['room_name'] ?? '');
            }
        }
        echo PHP_EOL;
    }
    printf("total %d ms (as buscas correram em paralelo)\n", $took);

    // 4. cotação da primeira tarifa, para ver preço e condições confirmados
    if (isset($opt['quote']) && $first !== null) {
        $q = $api->quote($first['rate_token']);
        $offer = $q['offer'] ?? [];
        printf("\ncotação: %s %s · mudanças: %d · offer_token expira em %s\n", $offer['rate']['net']['amount'] ?? '?',
            $offer['rate']['net']['currency'] ?? '', count($q['changes'] ?? []), $q['expires_at'] ?? $offer['expires_at'] ?? '?');
    }
} catch (ApiException $e) {
    fwrite(STDERR, $e->getMessage() . PHP_EOL);
    foreach ($e->details as $d) {
        fwrite(STDERR, sprintf("  %s: %s\n", $d['field'] ?? '', $d['code'] ?? ''));
    }
    exit(1);
} catch (Throwable $e) {
    fwrite(STDERR, $e->getMessage() . PHP_EOL);
    exit(1);
}

/**
 * O primeiro resultado do autocomplete, como filtro da busca de conteúdo.
 *
 * @return array<string, string>
 */
function firstDestination(Client $api, string $q): array
{
    $first = ($api->destinations($q)['results'] ?? [])[0] ?? null;
    if ($first === null) {
        throw new InvalidArgumentException("destino não encontrado: {$q}");
    }
    fprintf(STDERR, "destino: %s (%s)\n", $first['name'], $first['type']);
    return match ($first['type']) {
        'city' => ['city_id' => $first['id']],
        'hotel' => ['q' => $first['name']],
        default => ['destination_id' => $first['id']],
    };
}
