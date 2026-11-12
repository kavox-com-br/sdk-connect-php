# Kavox Connect — SDK PHP

Cliente PHP pequeno (sem dependências além de `curl` e `json`) da API de produtos do Kavox Connect (`/v1`):
conteúdo do catálogo, busca de tarifas, cotação e reserva de hotel. A referência completa da API fica no
próprio Connect, em `/docs`.

## Configuração

1. No painel do Connect, tela **Chaves**: **Criar chave de desenvolvimento** gera uma `kcx_test_…` que usa
   o simulador (`mock`) e lê o catálogo. Para um parceiro real, crie uma chave com permissão nele.
2. `cp .env.example .env` e preencha `KAVOX_CONNECT_URL` e `KAVOX_CONNECT_KEY` (vale também por variável de
   ambiente). **Nunca versione a chave.**

## Exemplo: busca pela linha de comando

```bash
php examples/search.php --q=Copacabana --quote                      # por nome, cota a primeira tarifa
php examples/search.php --destination=Gramado --max=200 --rates=1   # cidade inteira, lotes de 90 em paralelo
php examples/search.php --giata=10746,31207 --checkin=2027-01-10 --nights=3 --adults=2,1 --children=7
php examples/search.php --hotels=<uuid>,<uuid> --integration=mock,expedia --json
```

Hotéis por `--q`, `--destination`, `--city` (city_id), `--hotels` (hotel_id do catálogo), `--giata` (id do
GIATA) ou `--codes` (código do parceiro). Padrão: `mock`, daqui a 30 dias, 2 noites, 2 adultos, 3 tarifas por
hotel.

## No seu código

```php
require 'src/autoload.php'; // ou vendor/autoload.php com Composer

use Kavox\Connect\Client;

$api = Client::fromEnv();

// os hotéis: guarde o catálogo do seu lado; aqui, direto da busca de conteúdo
$ids = $api->contentHotelIds(['city_id' => $cityId], 500);

// uma busca por integração e por lote de 90, todas ao mesmo tempo
$answers = $api->searchMany(['expedia', 'hotelbeds'], ['hotel_ids' => $ids], '2027-01-10', '2027-01-12',
    [['adults' => 2], ['adults' => 1, 'children_ages' => [7]]], ['max_rates_per_hotel' => 5]);

// ou uma busca só, também por id do GIATA
$res = $api->search('expedia', ['giata_hotel_ids' => [10746]], '2027-01-10', '2027-01-12', [['adults' => 2]]);

$quote = $api->quote($res['results'][0]['rates'][0]['rate_token']);

// reserva: gere a chave antes e guarde-a; repetir com ela nunca reserva duas vezes
$key = Client::uuid();
$booking = $api->book(['offer_token' => $quote['offer_token'], /* holder, rooms[].guests ... */], $key);
```

O Connect não espalha a busca por parceiros nem junta respostas: cada chamada é uma integração e até 90
hotéis. `searchMany` faz as chamadas em paralelo (curl multi) e devolve cada uma com `response` ou `error`,
sem que uma falha derrube as outras.

## Erros

Toda falha da API vira `Kavox\Connect\ApiException`: `status`, `errorCode` (ex.: `VALIDATION`,
`PRICE_CHANGED`, `SUPPLIER_UNAVAILABLE`), `retryable`, `details` (campo a campo), `requestId` (o que o suporte
pede), `integration`, `supplierCode`/`supplierMessage` (do parceiro, só para log) e `raw` (o objeto `error`
inteiro, com a `offer` nova num `PRICE_CHANGED`).
