<?php

declare(strict_types=1);

// Sem Composer: require este arquivo. Com Composer, use vendor/autoload.php (PSR-4 Kavox\Connect\ → src/).
spl_autoload_register(static function (string $class): void {
    $prefix = 'Kavox\\Connect\\';
    if (str_starts_with($class, $prefix)) {
        require __DIR__ . '/' . str_replace('\\', '/', substr($class, strlen($prefix))) . '.php';
    }
});
