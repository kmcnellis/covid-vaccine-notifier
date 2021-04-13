(function () {
  var signUpForm = document.querySelector('.signup-form');
  var signUpButton = document.querySelector('.signup-button');
  signUpForm.addEventListener('submit', function (e) {
    e.preventDefault();
    signUpButton.disabled = true;
    var elements = signUpForm.elements;
    var reqBody = {};
    for (var i = 0; i < elements.length; i++) {
      var input = elements[i];
      var name = input.dataset.name || input.name;
      var type = input.dataset.type || input.type;
      if (!name || !type) continue;
      switch (type) {
        case 'select-one':
        case 'text':
          reqBody[name] = input.value;
          break;
        case 'number':
          reqBody[name] = Number(input.value);
          break;
        default:
          alert('Cannot handle input type: ' + type + ' for input: ' + name);
          break;
      }
    }
    var xhr = new XMLHttpRequest();
    xhr.open("POST", "/subscribe");
    xhr.setRequestHeader("Content-Type", "application/json;charset=utf-8");
    xhr.onload = function () {
      if (xhr.status >= 200 && xhr.status < 300) {
        console.log(xhr.responseText);
        alert(xhr.responseText);
        signUpButton.disabled = false;
      } else {
        // HTTP error
        console.error(xhr.responseText);
        alert(message);
        signUpButton.disabled = false;
      }
    };
    xhr.onerror = function () {
      var message = 'A network error has occurred. Please try again.';
      console.error(message);
      alert(message);
      signUpButton.disabled = false;
    };
    // {state": "CA", "vaccine":"jj", "phone":"+1 (555) 555-5555", "distance":15, "zip":"94110", "threshold":3}
    xhr.send(JSON.stringify(reqBody));
  }, false)
})();
