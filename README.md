# Kavox Connect — SDK PHP

Cliente PHP pequeno (sem dependências além de `curl` e `json`) da API de produtos do Kavox Connect (`/v1`):
conteúdo do catálogo, busca de tarifas, cotação e reserva de hotel. A referência completa da API fica no
próprio Connect, em `/docs`.

## Configuração

1. No painel do Connect, tela **Chaves**: **Criar chave de desenvolvimento** gera uma `kcx_test_…` que usa
   o simulador (`mock`) e lê o catálogo. Para um parceiro real, crie uma chave com permissão nele.
2. `cp .env.example .env` e preencha `KAVOX_CONNECT_URL` e `KAVOX_CONNECT_KEY` (vale também por variável de
   ambiente). **Nunca versione a chave.**

## Tela de teste (HTML)

```bash
php -S localhost:8300 -t public
```

Abra `http://localhost:8300`. Tudo o que a API faz, pela tela:

- **Hotel**: busca por destino (autocomplete), nome, `hotel_id`, id do GIATA, código do parceiro ou destino
  do próprio parceiro (para parceiro fora do GIATA, com a lista de hotéis dele); vários quartos e crianças;
  sem máximo de hotéis por busca. Ficha do hotel (fotos, textos,
  comodidades), cotação (mudanças, avisos do parceiro, política e taxas) e reserva com `Idempotency-Key`.
- **Reservas**: lista (API de gestão), consulta no parceiro e cancelamento com multa máxima; e a leitura de
  uma reserva direto no parceiro, pelo id dele, para a que não passou pelo Connect.
- **Credenciais**: parceiros e credenciais da conta; criar pelo formulário que o próprio parceiro descreve
  (`credential_schema`), editar, testar a conexão, pausar e excluir.
- **Chaves**: chaves de produto com permissões por produto, parceiro, credencial e operação; chave de
  desenvolvimento; a chave criada pode virar a chave da tela com um clique.
- **Console** e a barra de baixo: toda chamada com requisição (curl pronto para copiar) e resposta como vieram,
  status, tempo e `request_id`.
- Com o simulador (`mock`), cada operação tem o seletor de cenário (`X-Mock-Scenario`): sem
  disponibilidade, preço mudou, reserva pendente, multa no cancelamento, parceiro fora…

As chaves ficam no servidor PHP (`public/api.php`), nunca no navegador. A tela lê `KAVOX_CONNECT_URL`,
`KAVOX_CONNECT_KEY` e `KAVOX_CONNECT_MGMT_KEY` (chave de gestão, `kcx_mgmt_…`, criada pelo dono da conta no
painel) do `.env`; em **Configuração** dá para trocar nesta sessão. Num servidor exposto, defina
`KAVOX_SDK_PASSWORD`: a tela passa a pedir senha.

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
$booking = $api->book(['offer_token' => $quote['offer']['offer_token'], 'rooms' => [['guests' => [
    ['first_name' => 'Ana', 'last_name' => 'Souza'], ['first_name' => 'Rui', 'last_name' => 'Souza'],
]]]], $key);

// cancelar também leva Idempotency-Key
$api->cancel($booking['booking']['id'], Client::uuid());
```

O Connect não espalha a busca por parceiros nem junta respostas: cada chamada é uma integração e uma lista
de hotéis, sem máximo. `searchMany` faz as chamadas em paralelo (curl multi) e devolve cada uma com `response` ou `error`,
sem que uma falha derrube as outras.

## Parceiro fora do GIATA

Parceiro que não está no GIATA (hoje a E-HTL, `ehtl`) não tem hotel no catálogo do Connect. Os destinos e os
hotéis são os **do próprio parceiro**, lidos pelo Connect na hora, e o id de um destino só vale naquele
parceiro:

```php
$dest = $api->supplierDestinations('ehtl', 'acrelandia')['destinations'][0];   // {id, name, region, country}
$hotels = $api->supplierHotels('ehtl', $dest['id'])['hotels'];                  // supplier_hotel_id, name…

// tarifas de todo o destino do parceiro…
$api->search('ehtl', ['supplier_destination_id' => $dest['id']], '2027-01-12', '2027-01-14', [['adults' => 2]]);
// …ou só de alguns hotéis dele
$api->search('ehtl', ['supplier_hotel_ids' => array_column($hotels, 'supplier_hotel_id')], '2027-01-12', '2027-01-14', [['adults' => 2]]);

// uma reserva antiga, que não passou pelo Connect: lida direto no parceiro, pelo id dele
// (na E-HTL o locator é o UUID do Quasar ou o número da reserva, só dígitos)
$old = $api->supplierBooking('ehtl', locator: '7ff42a70-097c-4cab-9450-5c62cb289158')['booking'];
```

`supplierBooking` pede a permissão `supplier_bookings` na chave, separada de `retrieve`: sem ela, a resposta
é `403 OPERATION_NOT_ALLOWED`.

`GET /v1/integrations` diz o que cada parceiro faz em `capabilities.hotel`: `supplier_catalog`,
`supplier_destination_search` e `supplier_bookings`.

## Erros

Toda falha da API vira `Kavox\Connect\ApiException`: `status`, `errorCode` (ex.: `VALIDATION`,
`PRICE_CHANGED`, `SUPPLIER_UNAVAILABLE`), `retryable`, `details` (campo a campo), `requestId` (o que o suporte
pede), `integration`, `supplierCode`/`supplierMessage` (do parceiro, só para log) e `raw` (o objeto `error`
inteiro, com a `offer` nova num `PRICE_CHANGED`).

## Licença

MIT, veja `LICENSE`. A marca e o logo da Kavox (`public/brand/`) não entram na licença.
