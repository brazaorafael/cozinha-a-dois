# Guia de instalação — sem terminal

Reserve cerca de 35 minutos. Você vai usar apenas os sites do GitHub e do Cloudflare.

## Antes de começar

Tenha em mãos:

- uma chave da API do Gemini;
- um endereço Gmail;
- uma Senha de App do Gmail;
- os e-mails que receberão o cardápio;
- uma conta gratuita no GitHub;
- uma conta gratuita no Cloudflare.

O Pexels é opcional e aparece sempre identificado como imagem ilustrativa.

## Parte 1 — GitHub

1. No GitHub, crie um repositório chamado `cozinha-a-dois`.
2. Escolha **Public**. Não marque opções de README ou licença.
3. Na tela do repositório, use **Add file → Upload files**.
4. Envie todo o conteúdo desta pasta, mantendo as subpastas.
5. Confirme em **Commit changes**.
6. Abra **Settings → Pages**.
7. Em **Build and deployment**, escolha **Deploy from a branch**.
8. Selecione a branch `main` e a pasta `/ (root)`. Salve.
9. Aguarde o GitHub mostrar a URL do app, parecida com:
   `https://SEU_USUARIO.github.io/cozinha-a-dois/`

### Segredos do GitHub

Abra **Settings → Secrets and variables → Actions → Secrets → New repository secret** e crie:

- `GEMINI_API_KEY`
- `GMAIL_ADDRESS`
- `GMAIL_APP_PASSWORD`
- `MAIL_TO` — um ou mais e-mails, separados por vírgula

Opcional:

- `PEXELS_KEY`

Abra a aba **Variables** e crie:

- `APP_URL` — a URL do GitHub Pages
- `GEMINI_MODEL` — `gemini-2.5-flash`
- `ENABLE_PEXELS_FALLBACK` — `true`

## Parte 2 — token do GitHub

1. Clique na sua foto no GitHub.
2. Abra **Settings → Developer settings → Personal access tokens → Fine-grained tokens**.
3. Crie um token com acesso apenas ao repositório `cozinha-a-dois`.
4. Em permissões do repositório, habilite **Contents: Read and write**.
5. Copie o token. Ele será colado uma única vez no Cloudflare.

## Parte 3 — Cloudflare Worker conectado ao Git

Antes de conectar:

1. Abra `wrangler.toml` no GitHub.
2. Clique no lápis para editar.
3. Troque `SEU_USUARIO` pelo seu usuário do GitHub em `REPO` e `ALLOWED_ORIGINS`. O valor de `REPO` deverá ficar parecido com `seu-usuario/cozinha-a-dois`.
4. Salve em **Commit changes**.

Agora, no Cloudflare:

1. Abra **Workers & Pages**.
2. Crie uma aplicação usando **Import a repository**.
3. Escolha `cozinha-a-dois`.
4. Nomeie como `cozinha-a-dois-worker`.
5. Use o comando de deploy `npx wrangler deploy`.
6. Se o painel pedir um comando de build, deixe vazio.
7. Publique.

Se o painel oferecer **Build watch paths**, inclua apenas:

- `worker.js`
- `wrangler.toml`

Assim, as atualizações diárias de receitas não reimplantam o Worker sem necessidade.

Em **Settings → Variables and Secrets**, crie como **Secret**:

- `GITHUB_TOKEN`
- `GEMINI_API_KEY`
- `PEXELS_KEY` — opcional

As outras variáveis já estão no `wrangler.toml`.

Copie a URL final do Worker, parecida com:
`https://cozinha-a-dois-worker.seu-usuario.workers.dev`

## Parte 4 — criar o banco e o espaço de fotos

Estas duas configurações ativam o caderno de Gostei sincronizado e o envio de fotos.
Os nomes dos bindings precisam ser exatamente os indicados.

### Banco D1

1. No painel do Cloudflare, abra **Storage & databases → D1 SQL database**.
2. Clique em **Create database**.
3. Use o nome `cozinha-a-dois`.
4. Volte ao Worker `cozinha-a-dois-worker`.
5. Abra **Settings → Bindings → Add binding**.
6. Escolha **D1 database**.
7. Em **Variable name**, escreva `DB`.
8. Selecione o banco `cozinha-a-dois` e salve.

Não é necessário colar comandos SQL. No primeiro uso, o próprio Worker cria as tabelas.
O arquivo `schema.sql` está no repositório apenas como cópia de segurança.

### Fotos R2

1. No painel do Cloudflare, abra **Storage & databases → R2 Object Storage**.
2. Clique em **Create bucket**.
3. Use o nome `cozinha-a-dois-fotos`.
4. Volte ao Worker `cozinha-a-dois-worker`.
5. Abra **Settings → Bindings → Add binding**.
6. Escolha **R2 bucket**.
7. Em **Variable name**, escreva `PHOTOS`.
8. Selecione `cozinha-a-dois-fotos` e salve.

O bucket não precisa ser público. As imagens são entregues pelo próprio Worker.

Depois de salvar os dois bindings, abra a URL do Worker no navegador. Ela deve mostrar:

- `"banco": true`
- `"fotos": true`

## Parte 5 — ligar o app ao Worker

1. No GitHub, abra `config.js`.
2. Clique no lápis.
3. Cole a URL do Worker entre as aspas de `WORKER_URL`.
4. Se quiser, troque `NOME_CASAL`.
5. Salve em **Commit changes**.

Em alguns minutos, o GitHub Pages publica a mudança.

## Parte 6 — primeira geração

1. No repositório, abra **Actions**.
2. Selecione **Gerar cardápio e enviar e-mail**.
3. Clique em **Run workflow**.
4. Rode uma vez com `diario`.
5. Rode novamente com `semanal`.

Quando os dois fluxos terminarem com marca verde, o app já terá cardápio real.

## Instalar no iPhone

1. Abra a URL do app no Safari.
2. Toque em **Compartilhar**.
3. Escolha **Adicionar à Tela de Início**.

## Se algo der errado

- **O app abre, mas a busca web não funciona:** confira a URL em `config.js` e os Secrets do Worker.
- **As receitas não mudam:** abra Actions e veja se a última execução está verde.
- **O e-mail não chega:** confirme a Senha de App do Gmail e `MAIL_TO`.
- **A foto não aparece:** isso pode ser intencional; a versão só mostra foto que passou pela validação.
- **A foto enviada não é guardada:** abra a URL do Worker e confirme se `banco` e `fotos` aparecem como `true`.
- **Favoritos não sincronizam entre aparelhos:** confirme o binding D1 com o nome exato `DB`.
- **O link abre o Google:** a fonte direta não passou pela validação. É uma proteção contra URL errada.
