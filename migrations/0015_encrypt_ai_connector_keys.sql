-- Connector API keys are encrypted by the application using
-- AI_CONNECTOR_ENCRYPTION_KEY. The post-migration boot hook encrypts any
-- legacy plaintext values before the API starts serving requests.
COMMENT ON COLUMN ai_connectors.api_key IS
    'AES-256-GCM ciphertext, encoded as v1:<hex(nonce+ciphertext+tag)>';
