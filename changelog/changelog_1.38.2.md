# Changelog — Plateforme Web v1.38.2

## [FIXED]

### PDF combiné — les identifiants n'étaient saisissables que dans la section anglaise

`add_form_fields` s'arrêtait (`break`) dès la première page contenant l'emplacement réservé. Dans l'édition combinée, cet emplacement apparaît **une fois par langue** : seule la première section, l'anglaise, recevait ses champs. Les trois autres gardaient les pointillés, non modifiables.

Les huit widgets sont désormais créés, et surtout **fusionnés en deux champs partagés** : saisir l'identifiant dans n'importe quelle section le renseigne dans les quatre.

C'est la structure normale d'un formulaire PDF, mais `add_widget()` de PyMuPDF ne la produit pas : il crée un champ indépendant par widget, si bien que quatre copies nommées `username` restaient quatre cases sans rapport (vérifié : taper dans l'une laissait les autres vides). En PDF, un champ est **un** objet dont les `/Kids` sont les widgets posés sur les pages ; la valeur `/V` vit sur le parent, pas sur les widgets. `sharedfields.py` réécrit l'AcroForm dans cette forme :

* un objet parent par identifiant, portant `/T`, `/FT /Tx`, `/V` et la liste des `/Kids` ;
* les widgets perdent leurs propres `/T`, `/FT`, `/V` — un enfant qui garde son `/T` produirait le nom qualifié `username.username` et casserait le partage — et reçoivent `/Parent` ;
* `/Fields` de l'AcroForm ne référence plus que les deux parents, et `/NeedAppearances true` demande au lecteur de redessiner chaque widget à partir de la valeur commune.

Vérifié sur le document produit : la valeur écrite une fois sur le champ se relit à l'identique aux huit emplacements, dans les quatre langues. Les quatre PDF par langue n'ont qu'une occurrence chacun et ne sont pas concernés par la fusion.

Au passage, `/AcroForm` peut être une référence indirecte ou un dictionnaire écrit sur place ; les deux cas sont traités.
