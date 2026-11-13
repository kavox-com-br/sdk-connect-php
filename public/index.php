<?php

declare(strict_types=1);

// A tela de teste do Kavox Connect. Suba com: php -S localhost:8300 -t public
require dirname(__DIR__) . '/src/autoload.php';

$password = Kavox\Connect\Client::env()['KAVOX_SDK_PASSWORD'] ?? '';
if ($password !== '' && !hash_equals($password, (string) ($_SERVER['PHP_AUTH_PW'] ?? ''))) {
    header('WWW-Authenticate: Basic realm="Kavox Connect SDK"');
    http_response_code(401);
    exit('senha');
}
$v = (string) max(filemtime(__DIR__ . '/app.js'), filemtime(__DIR__ . '/app.css'));
?>
<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#ffffff">
  <title>Kavox Connect · SDK</title>
  <link rel="icon" href="favicon.png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400..700&display=swap">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/primeicons@7.0.0/primeicons.css">
  <link rel="stylesheet" href="app.css?v=<?= $v ?>">
</head>
<body>
  <a class="skip" href="#view">Pular para o conteúdo</a>
  <header class="top">
    <a class="brand" href="#/hotel" translate="no">
      <img src="brand/logo.png" alt="Kavox" width="99" height="24">
      <span class="product">Connect</span>
      <span class="tag">SDK</span>
    </a>
    <nav class="tabs" id="tabs" aria-label="Seções">
      <span class="group">Produtos</span>
      <a href="#/hotel" data-tab="hotel"><i class="pi pi-building" aria-hidden="true"></i>Hotel</a>
      <a href="#/reservas" data-tab="reservas"><i class="pi pi-calendar" aria-hidden="true"></i>Reservas</a>
      <a href="#/seguro" data-tab="seguro"><i class="pi pi-shield" aria-hidden="true"></i>Seguro viagem</a>
      <a href="#/cartoes" data-tab="cartoes"><i class="pi pi-credit-card" aria-hidden="true"></i>Cartões virtuais</a>
      <span class="group">Gestão</span>
      <a href="#/credenciais" data-tab="credenciais"><i class="pi pi-lock" aria-hidden="true"></i>Credenciais</a>
      <a href="#/chaves" data-tab="chaves"><i class="pi pi-key" aria-hidden="true"></i>Chaves</a>
      <span class="group">Ferramentas</span>
      <a href="#/console" data-tab="console"><i class="pi pi-code" aria-hidden="true"></i>Console <span id="console-count" class="count" aria-label="chamadas registradas"></span></a>
      <a href="#/config" data-tab="config"><i class="pi pi-cog" aria-hidden="true"></i>Configuração</a>
    </nav>
    <div class="who" id="who" aria-live="polite"></div>
  </header>
  <main id="view" class="view" tabindex="-1"></main>
  <section id="drawer" class="drawer" hidden aria-label="Requisições e respostas">
    <div class="drawer-head">
      <strong><i class="pi pi-code" aria-hidden="true"></i> Requisições e respostas</strong>
      <span class="muted small">as 50 últimas desta tela · <a href="#/console">ver todas no Console</a></span>
      <button type="button" id="drawer-close" class="sm" aria-label="Fechar o painel de requisições"><i class="pi pi-times" aria-hidden="true"></i> Fechar</button>
    </div>
    <div id="drawer-list" class="drawer-list"></div>
  </section>
  <div id="dock" class="dock" hidden>
    <button type="button" id="dock-toggle" aria-expanded="false" aria-controls="drawer">
      <img src="brand/icon.png" alt="" width="18" height="18">
      <span class="dock-label">Última chamada</span>
      <span id="dock-last" class="dock-last"></span>
      <i class="pi pi-chevron-up" aria-hidden="true"></i>
    </button>
  </div>
  <div id="toast" class="toast" role="status" aria-live="polite"></div>
  <dialog id="modal" class="modal" aria-labelledby="modal-title"><div class="modal-body" id="modal-body"></div></dialog>
  <script src="app.js?v=<?= $v ?>"></script>
</body>
</html>
