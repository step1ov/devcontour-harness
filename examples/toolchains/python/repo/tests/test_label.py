from fx_label import label


def test_label_pads_one_digit():
    assert label(7) == "item-007"


def test_label_pads_two_digits():
    assert label(42) == "item-042"


def test_label_keeps_long():
    assert label(1234) == "item-1234"
