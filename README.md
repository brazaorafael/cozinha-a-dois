# Cozinha — Ana & Rafael

Nome recomendado do repositório: `cozinha-a-dois`.

App privado de planejamento de jantares, feito para custar praticamente zero:

- site estático no GitHub Pages;
- geração automática e e-mail pelo GitHub Actions;
- chamadas com segredo em um único Cloudflare Worker;
- receitas e preferências em arquivos JSON versionados no próprio repositório.

## O que esta versão melhora

1. **Fotos honestas:** a imagem da página original só aparece quando a página e o título passam por validação. O Pexels é opcional e sempre aparece como “imagem ilustrativa”. Sem foto confiável, o card usa uma capa tipográfica — nunca uma foto genérica fingindo ser o prato.
2. **Busca rápida e resiliente:** o app pesquisa primeiro no acervo local, instantaneamente. A busca web roda como trabalho em segundo plano no Worker, fica em cache por 12 horas e pode ser retomada se o celular suspender a tela.
3. **Links confiáveis:** o link direto só aparece quando a URL responde, pertence a um domínio permitido e realmente parece ser a receita. Caso contrário, o app abre uma busca pelo nome do prato.
4. **Votos sem contagem duplicada:** trocar de 👍 para 👎 recalcula o perfil; não soma votos antigos indefinidamente.
5. **Operação simples:** `config.js` é o único arquivo que normalmente precisa ser editado depois da publicação.

## Instalação

Abra [GUIA_DE_INSTALACAO.md](./GUIA_DE_INSTALACAO.md). O guia foi escrito para uso pela interface do GitHub e do Cloudflare, sem terminal.

## Estrutura

- `index.html`, `styles.css`, `app.js`: aplicativo.
- `config.js`: endereço do Worker e nome do casal.
- `worker.js`, `wrangler.toml`: mini-backend no Cloudflare.
- `refeicoes_agent.py`: geração, validação e e-mail.
- `recipe_verifier.py`: validação independente de URL, título, JSON-LD e imagem.
- `registrar_gosto.py`: perfil de preferências idempotente.
- `data/`: banco de dados em JSON.
- `.github/workflows/`: horários e registro de votos.

## Privacidade

O GitHub Pages exige repositório público no plano gratuito em muitos cenários. Portanto, não coloque chaves, senhas, e-mails pessoais ou outras informações privadas nos arquivos. Os segredos ficam apenas em GitHub Secrets e Cloudflare Secrets. Para privacidade real de acesso, use um repositório/plano que aceite Pages privado ou publique o frontend num serviço com controle de acesso.
