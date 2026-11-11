-- Optional owner-confirmed read access; existing manual mappings and receipts stay intact.
ALTER TABLE hub_flintplate_connections
    ADD COLUMN source_base_url TEXT,
    ADD COLUMN source_api_key_ciphertext TEXT,
    ADD CONSTRAINT flintplate_source_credentials_complete CHECK (
        (source_base_url IS NULL AND source_api_key_ciphertext IS NULL)
        OR (source_base_url IS NOT NULL AND source_api_key_ciphertext IS NOT NULL
            AND octet_length(source_base_url) BETWEEN 1 AND 2048
            AND octet_length(source_api_key_ciphertext) BETWEEN 62 AND 8252
            AND source_api_key_ciphertext LIKE 'fp1:%')
    );
