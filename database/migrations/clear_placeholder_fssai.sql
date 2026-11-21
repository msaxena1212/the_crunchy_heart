-- The FSSAI licence number is now managed in Admin > Settings. Remove the placeholder
-- value that older seeds wrote on every product so it is never shown to customers.
UPDATE products SET fssai_license_number = NULL WHERE fssai_license_number = '10424000000001';
ALTER TABLE products ALTER COLUMN fssai_license_number DROP DEFAULT;
