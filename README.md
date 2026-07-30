# Cozinha — Ana & Rafael

Nome recomendado do repositório: `cozinha-a-dois`.

App privado de planejamento de jantares, feito para custar praticamente zero:

- site estático no GitHub Pages;
- geração automática e e-mail pelo GitHub Actions;
- chamadas com segredo em um único Cloudflare Worker;
- cardápio e perfil agregado em JSON no repositório;
- favoritos e estado da lista no Cloudflare D1;
- fotos enviadas pelo casal no Cloudflare R2.

## O que esta versão melhora

1. **Fotos honestas:** a imagem da página original só aparece quando a página e o título passam por validação. O Pexels é opcional e sempre aparece como “imagem ilustrativa”. Sem foto confiável, o card usa uma capa tipográfica — nunca uma foto genérica fingindo ser o prato.
2. **Busca rápida e resiliente:** o app pesquisa primeiro no acervo local, instantaneamente. A busca web roda como trabalho em segundo plano no Worker, fica em cache por 12 horas e pode ser retomada se o celular suspender a tela.
3. **Links confiáveis:** o link direto só aparece quando a URL responde, pertence a um domínio permitido e realmente parece ser a receita. Caso contrário, o app abre uma busca pelo nome do prato.
4. **Votos sem contagem duplicada:** trocar de 👍 para 👎 recalcula o perfil; não soma votos antigos indefinidamente.
5. **Operação simples:** `config.js` é o único arquivo que normalmente precisa ser editado depois da publicação.
6. **Caderno do casal:** uma foto de prato, página ou captura de tela é identificada, associada a uma receita e guardada automaticamente em Gostei.
7. **Lista estável:** entrar e sair da aba não refaz a lista. Ela muda apenas quando uma receita ou item é incluído/retirado, ou quando o botão **Limpar lista** é usado.
8. **Acervo ampliado:** a busca e as sugestões usam 18 fontes permitidas, divididas em três níveis de confiança.

## Instalação

Abra [GUIA_DE_INSTALACAO.md](./GUIA_DE_INSTALACAO.md). O guia foi escrito para uso pela interface do GitHub e do Cloudflare, sem terminal.

## Estrutura

- `index.html`, `styles.css`, `app.js`: aplicativo.
- `config.js`: endereço do Worker e nome do casal.
- `worker.js`, `wrangler.toml`: mini-backend no Cloudflare.
- `schema.sql`: estrutura de consulta do D1; o Worker cria as tabelas automaticamente.
- `refeicoes_agent.py`: geração, validação e e-mail.
- `recipe_verifier.py`: validação independente de URL, título, JSON-LD e imagem.
- `registrar_gosto.py`: perfil de preferências idempotente.
- `data/`: cardápio público e resumo do perfil em JSON.
- `.github/workflows/`: horários e registro de votos.

## Privacidade

O GitHub Pages exige repositório público no plano gratuito em muitos cenários. Portanto, não coloque chaves, senhas, e-mails pessoais ou outras informações privadas nos arquivos. Os segredos ficam apenas em GitHub Secrets e Cloudflare Secrets. As fotos ficam no R2 e são servidas pelo Worker por endereços difíceis de adivinhar, mas isso não equivale a autenticação. Para privacidade real de acesso, use um frontend com controle de acesso.
