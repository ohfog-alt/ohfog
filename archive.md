---
title: "Archive"
permalink: /archive/
---

{% if site.posts.size > 0 %}
{% assign posts_by_year = site.posts | group_by_exp: "post", "post.date | date: '%Y'" %}
{% for year in posts_by_year %}
## {{ year.name }}

<ol class="post-list post-list--compact">
  {% for post in year.items %}
  <li>
    <time datetime="{{ post.date | date_to_xmlschema }}">{{ post.date | date: "%Y-%m-%d" }}</time>
    <a href="{{ post.url | relative_url }}">{{ post.title | escape }}</a>
  </li>
  {% endfor %}
</ol>
{% endfor %}
{% else %}
No posts published yet.
{% endif %}
