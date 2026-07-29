# Decisões técnicas e comparação com a versão recebida

## O que foi mantido

- GitHub Pages, GitHub Actions, Gemini, Gmail e um Cloudflare Worker.
- JSON no repositório como banco de dados.
- Cinco áreas: Hoje, Semana, Buscar, Lista e Perfil.
- Voto por prato, cardápio à la carte, foto de receita, lista por foto, consolidação e acompanhamentos.
- Arquitetura sem servidor tradicional e com custo muito baixo.

## O que mudou

### Fonte e imagem viraram dados verificados

Antes, `url` e `og:image` eram campos relativamente soltos. Agora cada prato possui:

- `fonte.status`: `verified` ou `unverified`;
- URL canônica, domínio, título, confiança e data de verificação;
- `imagem.kind`: `source`, `bank` ou `none`;
- crédito e identificador quando a imagem é do Pexels.

A validação exige domínio permitido, resposta HTML válida, sinais de conteúdo de receita e correspondência entre os títulos. JSON-LD do tipo `Recipe` é aproveitado quando existe.

### Busca em duas velocidades

O navegador filtra o acervo local imediatamente. Se o Worker estiver configurado, a pesquisa web é iniciada como trabalho em segundo plano e recebe um `job_id`. O navegador consulta o resultado depois; se o sistema suspender o app, o mesmo trabalho pode ser retomado. Resultados ficam no Cache API do Cloudflare por 12 horas.

### Pexels deixou de ser um “preenchedor automático”

O fallback vem desligado. Quando ativado, exige ao menos uma palavra relevante no texto alternativo da foto, evita IDs já utilizados quando informados e exibe o rótulo “Imagem ilustrativa”. A consequência honesta é que alguns cards terão uma capa gráfica, sem fotografia.

### Voto é estado, não soma infinita

O perfil guarda o voto atual por receita e recalcula contadores. Trocar a avaliação não duplica influência. Um identificador de evento evita processar o mesmo clique duas vezes.

### CORS e entrada mais restritos

O Worker pode aceitar apenas a origem do GitHub Pages, limita o tamanho do pedido e restringe páginas de receita a domínios configurados.

### Design

A base editorial foi mantida, mas o azul royal foi substituído por verde profundo, amarelo açafrão e papel quente. A navegação foi movida para uma barra inferior, mais confortável no celular. O estado da fonte passou a aparecer na própria receita.

## Custos e complexidade

O custo continua praticamente o mesmo. A complexidade interna aumentou no verificador de páginas e na busca assíncrona, mas a operação cotidiana ficou mais simples: normalmente só `config.js` precisa ser editado.

## Limitações que continuam existindo

- Sites podem bloquear robôs ou mudar o HTML; nesse caso, a fonte cai para “não confirmada”.
- Cache API não é um banco permanente. Uma busca antiga pode precisar ser refeita.
- O Pexels não entende perfeitamente nomes de pratos brasileiros.
- GitHub Actions agendado pode começar alguns minutos depois do horário.
- GitHub Pages público não é privacidade real. O app é pessoal, mas os JSONs ficam publicamente acessíveis.
