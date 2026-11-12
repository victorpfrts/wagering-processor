// Credenciais fictícias do LocalStack: os testes rodam sem depender do shell.
process.env['AWS_ACCESS_KEY_ID'] ??= 'test';
process.env['AWS_SECRET_ACCESS_KEY'] ??= 'test';
process.env['AWS_REGION'] ??= 'us-east-1';
